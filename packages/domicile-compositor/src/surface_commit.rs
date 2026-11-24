//! The surface commit path: what a client's `wl_surface.commit` does with its
//! buffer, and the buffer protocols.

use std::time::Instant;

use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::allocator::Buffer as _;
use smithay::reexports::wayland_server::Resource as _;
use smithay::reexports::wayland_server::{
    protocol::{wl_buffer, wl_surface::WlSurface},
    Client,
};
use smithay::utils::Transform;
use smithay::wayland::presentation::PresentationFeedbackCachedState;
use smithay::wayland::viewporter::ViewportCachedState;
use smithay::wayland::{
    buffer::BufferHandler,
    compositor::{
        with_states, BufferAssignment, CompositorClientState, CompositorHandler, CompositorState,
        SurfaceAttributes, SurfaceData,
    },
    dmabuf::{get_dmabuf, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
    shell::xdg::{PopupSurface, SurfaceCachedState, ToplevelSurface, XdgToplevelSurfaceData},
    shm::with_buffer_contents,
    shm::{ShmHandler, ShmState},
};
use smithay::{
    delegate_compositor, delegate_content_type, delegate_dmabuf, delegate_presentation,
    delegate_shm, delegate_single_pixel_buffer, delegate_viewporter,
};
use tracing::debug;

use crate::buffer_transform::{crop_in_buffer, upright_size, Sampled};
use crate::client_damage::{exact_damage, take_damage};
use crate::clients::ClientState;
use crate::dmabuf_import::DmabufImporter;
use crate::engine::NEWEST_BOX;
use crate::engine_damage;
use crate::frame_pacing::Paced;
use crate::frame_publishing::{Commit, Published};
use crate::scale::logical_size;
use crate::viewport::{source_pixels, surface_size, Viewport};
use crate::window_geometry::window_size;
use crate::DomicileCompositor;

/// What the compositor needs to know about a client's latest commit: source,
/// orientation and size. The pixels go to the engine untouched.
struct SurfaceTexture {
    /// Whether the buffer was a dmabuf or shm. Logged, since an shm frame costs
    /// an upload.
    from_dmabuf: bool,
    /// Whether the buffer is flipped, as GL clients flag on the dmabuf.
    y_inverted: bool,
    /// The surface's own logical size, or its `wp_viewport` size if set.
    ///
    /// Not the output's: a client that has not answered a configure is still
    /// its old size, and stretching it would hide that.
    logical_size: (f64, f64),
}

/// The committed state that maps a surface's buffer: double-buffered, so a
/// commit with no buffer can change it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mapping {
    pub buffer_scale: i32,
    pub buffer_transform: Transform,
    pub viewport: Viewport,
    /// See [`window_geometry`].
    pub geometry: Option<(i32, i32, i32, i32)>,
}

impl Mapping {
    /// What the engine samples of a `buffer`-pixel buffer, for a commit that
    /// answers a configure of `configured` size.
    ///
    /// Measured on the upright buffer, then mapped back into the buffer's own
    /// pixels.
    pub fn sampled(&self, buffer: (u32, u32), configured: Option<(i32, i32)>) -> Sampled {
        let size = upright_size(buffer, self.buffer_transform);
        let crop = crop_in_buffer(
            crate::window_geometry::crop(
                self.geometry,
                configured,
                surface_size(size, self.buffer_scale, self.viewport.size),
                size,
                source_pixels(size, self.buffer_scale, self.viewport.source),
            ),
            size,
            self.buffer_transform,
        );
        Sampled {
            crop,
            transform: self.buffer_transform,
        }
    }

    /// How many pixels of a `buffer`-pixel buffer, upright, span one of the
    /// surface's points across and down.
    pub fn pixels_a_point(&self, buffer: (u32, u32)) -> (f64, f64) {
        let size = upright_size(buffer, self.buffer_transform);
        let (width, height) = surface_size(size, self.buffer_scale, self.viewport.size);
        let (_, _, across, down) = source_pixels(size, self.buffer_scale, self.viewport.source)
            .unwrap_or((0.0, 0.0, f64::from(size.0), f64::from(size.1)));
        (across / f64::from(width), down / f64::from(height))
    }
}

/// What a commit answers. See [`crate::configure_answers`].
struct Answered {
    /// The size of the configure, which bounds the crop.
    configured: Option<(i32, i32)>,
    /// The engine's box at that size.
    at_box: u64,
    /// That box's size in device pixels, if known.
    box_size: Option<(u32, u32)>,
}

/// A window's last buffer, for a commit that attaches none.
#[derive(Clone, Copy, Debug)]
pub struct LastBuffer {
    /// In pixels.
    size: (u32, u32),
    /// The state it was last shown with.
    mapping: Mapping,
}

impl LastBuffer {
    /// The surface's logical size while it shows this buffer.
    pub fn logical_size(&self) -> (f64, f64) {
        let (width, height) = surface_size(
            upright_size(self.size, self.mapping.buffer_transform),
            self.mapping.buffer_scale,
            self.mapping.viewport.size,
        );
        (f64::from(width), f64::from(height))
    }
}

/// The role a surface committed in, for the steps of a commit that differ.
#[derive(Clone)]
pub enum Role {
    Toplevel(ToplevelSurface),
    Popup(PopupSurface),
    /// See `crate::subsurfaces`.
    Subsurface,
    /// An input method's candidate list. See `text_input.rs`.
    Candidates,
}

/// Which of the two kinds of client committed a buffer.
#[derive(Debug)]
enum Committer {
    /// A window on the desktop, named by the id the host gave it.
    App(String),
    /// The engine drawing the desktop itself.
    Chrome,
}

pub enum CommittedBuffer {
    Pixels { width: u32, height: u32 },
    Gpu(Dmabuf),
}

impl Role {
    /// What a log line calls this role.
    pub fn name(&self) -> &'static str {
        match self {
            Role::Toplevel(_) => "toplevel",
            Role::Popup(_) => "popup",
            Role::Subsurface => "subsurface",
            Role::Candidates => "candidates",
        }
    }
}

impl CommittedBuffer {
    /// The buffer's size, known without reading pixels.
    pub fn size(&self) -> (u32, u32) {
        match self {
            CommittedBuffer::Pixels { width, height, .. } => (*width, *height),
            CommittedBuffer::Gpu(dmabuf) => (dmabuf.width(), dmabuf.height()),
        }
    }
}

impl CompositorHandler for DomicileCompositor {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().unwrap().compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        if self.take_a_cursor_commit(surface) {
            return;
        }
        self.apply_the_commit(surface);
        self.tell_the_held_moves(surface);
    }

    /// A destroyed subsurface or candidate list goes at once: no commit will
    /// come to notice it.
    fn destroyed(&mut self, surface: &WlSurface) {
        self.candidates_destroyed(surface);
        self.subsurface_destroyed(surface);
    }
}

impl DomicileCompositor {
    /// One surface's part of a commit transaction.
    fn apply_the_commit(&mut self, surface: &WlSurface) {
        self.announce_a_new_popup(surface);
        self.place_a_repositioned_popup(surface);
        let children_changed = self.place_the_subsurfaces(surface);
        self.place_the_candidates(surface);
        let Some((committer, role)) = self.committer(surface) else {
            return;
        };
        // Send the initial configure once, so the client can map. A popup's was
        // sent in `new_popup`.
        if let Role::Toplevel(toplevel) = &role {
            let initial_configure_sent = with_states(surface, |states| {
                states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .initial_configure_sent
            });
            if !initial_configure_sent {
                toplevel.send_configure();
            }
        }

        if let Committer::App(app_id) = &committer {
            self.tell_the_size_limits(app_id, surface);
        }
        if let (Committer::App(app_id), Role::Toplevel(_)) = (&committer, &role) {
            self.tell_the_anchor(app_id, surface);
        }
        // A commit answers the client's last resize, so the newest one may go
        // out.
        if let (Committer::App(app_id), Role::Toplevel(toplevel)) = (&committer, &role) {
            let acked = with_states(surface, |states| {
                states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .current_serial
            });
            let waiting = self
                .configure_answers
                .get_mut(app_id)
                .and_then(|answers| answers.committed(acked));
            if let Some(resize) = waiting {
                self.send_resize(app_id, toplevel, resize);
            }
        }

        // Take the new buffer and the frame callbacks. Taking the buffer gives
        // us its release; otherwise Smithay holds it until the next buffer,
        // which the client may need the release to draw.
        let (attached, callbacks, buffer_scale, buffer_transform, viewport, geometry, damage) =
            with_states(surface, |states| {
                // Read with the buffer: the viewport is double-buffered and
                // applies to this commit.
                let viewport = {
                    let mut cached = states.cached_state.get::<ViewportCachedState>();
                    Viewport::from(&*cached.current())
                };
                let mut guard = states.cached_state.get::<SurfaceAttributes>();
                let attrs = guard.current();
                let attached = match attrs.buffer.take() {
                    Some(BufferAssignment::NewBuffer(buffer)) => (Some(buffer), false),
                    Some(BufferAssignment::Removed) => (None, true),
                    None => (None, false),
                };
                let callbacks = std::mem::take(&mut attrs.frame_callbacks);
                // Clear the accumulated damage, or it grows by a rectangle per
                // commit for the window's life.
                let damage = take_damage(&mut attrs.damage, attrs.buffer_scale, viewport);
                // The scale this buffer was drawn at. Read now; a client
                // mid-scale-change may commit the next one differently.
                let scale = attrs.buffer_scale;
                let transform = Transform::from(attrs.buffer_transform);
                drop(guard);
                // Double-buffered too; see `crate::window_geometry`.
                (
                    attached,
                    callbacks,
                    scale,
                    transform,
                    viewport,
                    window_geometry(states),
                    damage,
                )
            });
        // Whether the client took its buffer away, unmapping the window.
        let (attached, unmapped) = attached;
        let mapping = Mapping {
            buffer_scale,
            buffer_transform,
            viewport,
            geometry,
        };
        // A window's commit with no buffer that changes its mapping shows its
        // last buffer mapped anew: a resize through its viewport, scale,
        // transform or geometry.
        let remaps = match (&attached, &committer) {
            (None, Committer::App(app_id)) if !unmapped => self
                .last_buffers
                .get(app_id)
                .filter(|last| last.mapping != mapping)
                .map(|last| last.size),
            _ => None,
        };
        // Whether this commit puts up a frame of its own.
        let draws = attached.is_some() || remaps.is_some();
        // The buffer's size in pixels, if this commit shows one.
        let buffer_size = match &attached {
            Some(buffer) => committed_buffer(buffer).map(|committed| committed.size()),
            None => remaps,
        };
        tracing::trace!(
            surface = ?surface.id(),
            ?committer,
            role = role.name(),
            buffer = ?buffer_size,
            gpu = matches!(attached.as_ref().and_then(committed_buffer), Some(CommittedBuffer::Gpu(_))),
            remapped = remaps.is_some(),
            unmapped,
            scale = buffer_scale,
            damage = ?damage.as_ref().map(|region| (region.x, region.y, region.width, region.height)),
            callbacks = callbacks.len(),
            "a commit"
        );
        // A buffer of no known kind cannot be shown again.
        if let (Committer::App(app_id), true) = (
            &committer,
            attached.is_some() || remaps.is_some() || unmapped,
        ) {
            match buffer_size {
                Some(size) => self
                    .last_buffers
                    .insert(app_id.clone(), LastBuffer { size, mapping }),
                None => self.last_buffers.remove(app_id),
            };
        }
        if let (true, Committer::App(app_id), Role::Toplevel(toplevel)) =
            (attached.is_some() || remaps.is_some(), &committer, &role)
        {
            let drawn = buffer_size.map(|size| {
                surface_size(
                    upright_size(size, buffer_transform),
                    buffer_scale,
                    viewport.size,
                )
            });
            // A buffer of no known kind is not shown, so it has no size.
            if let Some(size) = window_size(geometry, drawn) {
                if self.unannounced.contains(app_id) {
                    self.announce_a_new_window(app_id, toplevel, size);
                } else {
                    self.tell_the_size(app_id, size);
                    self.hold_to_the_box(app_id, toplevel, size);
                }
            }
        }
        let feedback = with_states(surface, |states| {
            std::mem::take(
                &mut states
                    .cached_state
                    .get::<PresentationFeedbackCachedState>()
                    .current()
                    .callbacks,
            )
        });

        // Ask the client to draw its next frame (keeps it animating), unless
        // the page hid its window. Sent once its frame is shown, below.
        let callbacks = match self.window_of(surface) {
            Some(window) => self.held_frames.pass(&window, callbacks),
            None => callbacks,
        };

        // A theme turnover waits for each window to draw a new frame.
        if let (Some(_), Committer::App(app_id), Some(turnover)) =
            (&attached, &committer, &mut self.turnover)
        {
            let step = turnover.repainted(app_id);
            self.follow_the_turnover(step);
        }

        // Damage without a new buffer changes pixels the engine does not show,
        // and a window mapped again starts from nothing.
        if let (None, Committer::App(app_id)) = (&attached, &committer) {
            if damage.is_some() || unmapped {
                self.shown.missed(app_id);
            }
        }

        let remapped = match (remaps, &committer) {
            (Some(_), Committer::App(app_id)) => {
                let Answered {
                    configured, at_box, ..
                } = self.answered_box(surface, app_id, &role);
                self.remap_frame(app_id, &mapping, configured, at_box)
            }
            _ => None,
        };

        let shown = attached.and_then(|buffer| {
            // The gap since the last commit is time spent waiting on clients or
            // the throttle.
            let started = Instant::now();
            let waited = self.last_commit.map(|done| started.duration_since(done));
            // Only app commits after a keystroke count as responses.
            // Unprompted redraws (a blinking cursor) and chrome commits would
            // skew it.
            let responded = answers_keystroke(&committer)
                .then(|| self.pending_key.take())
                .flatten()
                .map(|keyed| started.duration_since(keyed));
            let (engine_holds, shown) = match &committer {
                Committer::App(app_id) => {
                    let Answered {
                        configured,
                        at_box,
                        box_size,
                    } = self.answered_box(surface, app_id, &role);
                    let sampled = buffer_size.map_or(
                        Sampled {
                            crop: (0, 0, 0, 0),
                            transform: buffer_transform,
                        },
                        |size| mapping.sampled(size, configured),
                    );
                    let crop = sampled.crop;
                    let pixels_a_point =
                        buffer_size.map_or((1.0, 1.0), |size| mapping.pixels_a_point(size));
                    self.cast_frame(app_id, &buffer, sampled, pixels_a_point, damage);
                    // A turned buffer's pixels land elsewhere on screen.
                    let upright = buffer_transform == Transform::Normal;
                    let commit = Commit {
                        surface,
                        buffer: &buffer,
                        sampled,
                        at_box,
                        box_size,
                        damage: exact_damage(damage, buffer_transform),
                    };
                    // Before the submit, which numbers this commit's frame.
                    let last = self
                        .engine
                        .as_ref()
                        .and_then(|session| session.frame_of(app_id));
                    self.presentations.committed(app_id, at_box, last);
                    self.sync_with_the_moves(app_id);
                    let published = self.publish_frame(app_id, &commit);
                    match published {
                        Published::Held | Published::Copied { .. } => self.shown.shown(
                            app_id,
                            engine_damage::Frame {
                                at_box,
                                crop,
                                buffer: buffer_size.expect("a shown frame has a buffer"),
                                upright,
                                texture: match published {
                                    Published::Copied { fourcc } => Some(fourcc),
                                    _ => None,
                                },
                            },
                        ),
                        Published::Waiting { .. } | Published::NotShown => {
                            self.shown.missed(app_id)
                        }
                    }
                    // After the submit, so there is something to sample, but
                    // timed from `started` so the import and submit count as
                    // ours.
                    self.drive_latency(
                        app_id,
                        started,
                        matches!(published, Published::Held | Published::Copied { .. }),
                    );
                    // The frame the engine will report, if it reached viz or
                    // goes up later.
                    let shown = match published {
                        Published::Held | Published::Copied { .. } => self
                            .engine
                            .as_ref()
                            .and_then(|session| session.frame_of(app_id))
                            .map(|frame| Paced::Submitted(app_id.clone(), frame)),
                        Published::Waiting { .. } => Some(Paced::Held(app_id.clone())),
                        Published::NotShown => None,
                    };
                    (
                        matches!(
                            published,
                            Published::Held | Published::Waiting { held: true }
                        ),
                        shown,
                    )
                }
                Committer::Chrome => {
                    self.publish_chrome_frame(&buffer, buffer_scale, viewport);
                    (false, None)
                }
            };
            // Release after the pixels are out, since the client may redraw
            // into it immediately. Always release, or a single-buffered client
            // stops drawing.
            //
            // Except a buffer the engine holds: viz samples it directly, so
            // releasing it would tear. The engine releases it, or
            // `EngineSession::overdue` takes it back.
            if !engine_holds {
                buffer.release();
                tracing::trace!(?committer, "buffer released");
            }
            let done = Instant::now();
            {
                let mut timings = self.hub.timings.lock().unwrap();
                if let Some(waited) = waited {
                    timings.idle.record(waited);
                }
                if let Some(responded) = responded {
                    timings.response.record(responded);
                }
                timings.commit.record(done - started);
            }
            self.last_commit = Some(done);
            shown
        });
        let shown = shown.or(remapped);
        self.answer_when_shown(shown, callbacks, feedback);
        self.show_the_subsurfaces(surface, children_changed, draws);
    }
}

impl DomicileCompositor {
    /// The size `role`'s commit was drawn for, the engine's box at that size,
    /// and the box's size. See `crop` and `crate::configure_answers`.
    fn answered_box(&mut self, surface: &WlSurface, app_id: &str, role: &Role) -> Answered {
        match role {
            Role::Toplevel(toplevel) => {
                let acked = with_states(surface, |states| {
                    states
                        .data_map
                        .get::<XdgToplevelSurfaceData>()
                        .unwrap()
                        .lock()
                        .unwrap()
                        .current_serial
                });
                let (at_box, box_size) = self.configure_answers.get_mut(app_id).map_or(
                    (crate::engine::LAST_SHOWN_BOX, None),
                    |answers| {
                        let at_box = answers.answered(acked);
                        (at_box, answers.box_size(at_box))
                    },
                );
                Answered {
                    configured: toplevel.current_state().size.map(|size| (size.w, size.h)),
                    at_box,
                    box_size,
                }
            }
            // The positioner's size, which the shell places.
            Role::Popup(popup) => Answered {
                configured: popup.with_pending_state(|state| {
                    Some((state.geometry.size.w, state.geometry.size.h))
                }),
                at_box: NEWEST_BOX,
                box_size: None,
            },
            // Sized by its own buffer.
            Role::Subsurface | Role::Candidates => Answered {
                configured: None,
                at_box: NEWEST_BOX,
                box_size: None,
            },
        }
    }
}

impl BufferHandler for DomicileCompositor {
    /// The client destroyed a buffer. Drop its import so the browser releases
    /// the fds, and forget any hold.
    fn buffer_destroyed(&mut self, buffer: &wl_buffer::WlBuffer) {
        if let Some(session) = self.engine.as_mut() {
            if !session.buffer_destroyed(buffer).is_empty() {
                tracing::debug!("a buffer the engine still held was destroyed by its client");
            }
        }
    }
}

impl ShmHandler for DomicileCompositor {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl DmabufHandler for DomicileCompositor {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(
        &mut self,
        _global: &DmabufGlobal,
        dmabuf: Dmabuf,
        notifier: ImportNotifier,
    ) {
        let gpu = self
            .gpu
            .as_mut()
            .expect("the dmabuf global is only advertised alongside a renderer");
        match DmabufImporter::validate(gpu.renderer(), &dmabuf) {
            Ok(()) => {
                if let Err(err) = notifier.successful::<DomicileCompositor>() {
                    tracing::debug!(?err, "client went away before its dmabuf was acknowledged");
                }
            }
            Err(err) => {
                tracing::warn!(format = ?dmabuf.format(), ?err, "rejecting a dmabuf the renderer cannot import");
                notifier.failed();
            }
        }
    }
}

delegate_compositor!(DomicileCompositor);

delegate_viewporter!(DomicileCompositor);

delegate_presentation!(DomicileCompositor);

delegate_single_pixel_buffer!(DomicileCompositor);

delegate_content_type!(DomicileCompositor);

delegate_shm!(DomicileCompositor);

delegate_dmabuf!(DomicileCompositor);

impl DomicileCompositor {
    /// Who committed `surface`, and in which role. Roles differ only in where
    /// the buffer goes and the requested size.
    fn committer(&self, surface: &WlSurface) -> Option<(Committer, Role)> {
        if let Some(chrome) = &self.chrome_toplevel {
            if chrome.wl_surface() == surface {
                return Some((Committer::Chrome, Role::Toplevel(chrome.clone())));
            }
        }
        self.by_surface
            .get(surface)
            .map(|(app_id, role)| (Committer::App(app_id.clone()), role.clone()))
    }

    /// Log the chrome frame's shape when it changes.
    ///
    /// The engine draws it, so nothing is kept.
    /// `e2e-chrome-fills-the-desktop.sh` reads the size from this line.
    fn publish_chrome_frame(
        &mut self,
        buffer: &wl_buffer::WlBuffer,
        buffer_scale: i32,
        viewport: Viewport,
    ) {
        let texture = committed_buffer(buffer)
            .and_then(|committed| self.texture_from(committed, buffer_scale, viewport));
        // Log on change. The buffer type, size and orientation explain a frame
        // that is the wrong size or upside down.
        let shape = texture.as_ref().map(|surface| {
            (
                surface.logical_size,
                surface.y_inverted,
                surface.from_dmabuf,
            )
        });
        if shape != self.chrome_frame_shape {
            self.chrome_frame_shape = shape;
            match shape {
                Some(((width, height), y_inverted, from_dmabuf)) => debug!(
                    width,
                    height,
                    y_inverted,
                    dmabuf = from_dmabuf,
                    scale = buffer_scale,
                    "the chrome committed a frame"
                ),
                None => debug!("the chrome's frame could not be made into a texture"),
            }
        }
    }

    /// Describe a committed buffer, dmabuf or shm.
    fn texture_from(
        &mut self,
        committed: CommittedBuffer,
        buffer_scale: i32,
        viewport: Viewport,
    ) -> Option<SurfaceTexture> {
        let (width, height) = committed.size();
        // The buffer's logical size, which a viewport source rectangle is
        // relative to. Not the surface size, which a viewport size
        // replaces.
        let (buffer_width, buffer_height) = logical_size((width, height), buffer_scale);
        let _buffer_logical = (f64::from(buffer_width), f64::from(buffer_height));
        let (logical_width, logical_height) =
            surface_size((width, height), buffer_scale, viewport.size);
        let logical_size = (f64::from(logical_width), f64::from(logical_height));
        match committed {
            CommittedBuffer::Gpu(dmabuf) => Some(SurfaceTexture {
                from_dmabuf: true,
                // GL clients flag a flipped buffer on the dmabuf.
                y_inverted: dmabuf.y_inverted(),
                logical_size,
            }),
            CommittedBuffer::Pixels { .. } => Some(SurfaceTexture {
                from_dmabuf: false,
                // Shm is laid out top-down.
                y_inverted: false,
                logical_size,
            }),
        }
    }
}

/// Whether this commit can answer a forwarded keystroke.
///
/// Only app windows can. The chrome repaints for its own reasons (a ticking
/// clock), and counting those would misreport the wait.
fn answers_keystroke(committer: &Committer) -> bool {
    match committer {
        Committer::App(_) => true,
        Committer::Chrome => false,
    }
}

/// Classify a committed buffer: a dmabuf if one is attached as user data,
/// otherwise shm.
pub fn committed_buffer(buffer: &wl_buffer::WlBuffer) -> Option<CommittedBuffer> {
    match get_dmabuf(buffer) {
        Ok(dmabuf) => Some(CommittedBuffer::Gpu(dmabuf.clone())),
        Err(_) => {
            shm_buffer_size(buffer).map(|(width, height)| CommittedBuffer::Pixels { width, height })
        }
    }
}

/// The size of a `wl_shm` buffer.
fn shm_buffer_size(buffer: &wl_buffer::WlBuffer) -> Option<(u32, u32)> {
    with_buffer_contents(buffer, |_ptr, _len, data| {
        Some((data.width.max(0) as u32, data.height.max(0) as u32))
    })
    .ok()
    .flatten()
}

/// The surface's committed `xdg_surface.set_window_geometry`, as `(x, y, width,
/// height)` in logical units.
pub fn window_geometry(states: &SurfaceData) -> Option<(i32, i32, i32, i32)> {
    states
        .cached_state
        .get::<SurfaceCachedState>()
        .current()
        .geometry
        .map(|rect| (rect.loc.x, rect.loc.y, rect.size.w, rect.size.h))
}

#[cfg(test)]
mod tests {
    use smithay::utils::{Rectangle, Transform};
    use smithay::wayland::viewporter::ViewportCachedState;

    use super::{answers_keystroke, Committer, Mapping};
    use crate::viewport::Viewport;

    #[test]
    fn a_source_only_viewport_is_sampled_unscaled_at_any_buffer_scale() {
        // A 1536-wide buffer cropped to 636 must fill a 636-wide box 1:1.
        let mapping = |buffer_scale, source: (f64, f64)| Mapping {
            buffer_scale,
            buffer_transform: Transform::Normal,
            viewport: Viewport::from(&ViewportCachedState {
                src: Some(Rectangle::new(source.into(), (636.0, 754.0).into())),
                dst: None,
            }),
            geometry: None,
        };

        assert_eq!(
            mapping(1, (0.0, 0.0))
                .sampled((1536, 754), Some((636, 754)))
                .crop,
            (0, 0, 636, 754)
        );
        assert_eq!(
            mapping(2, (8.0, 4.0))
                .sampled((1536, 1536), Some((636, 754)))
                .crop,
            (16, 8, 1272, 1508),
            "a source is in logical units, so scale 2 doubles it"
        );
    }

    #[test]
    fn a_fractionally_scaled_window_has_that_many_pixels_a_point() {
        // wp_fractional_scale at 1.75: a scale-1 buffer shown at a
        // destination 1.75 times smaller.
        let viewport = |dst: (i32, i32)| Mapping {
            buffer_scale: 1,
            buffer_transform: Transform::Normal,
            viewport: Viewport::from(&ViewportCachedState {
                src: None,
                dst: Some(dst.into()),
            }),
            geometry: None,
        };
        let scaled = Mapping {
            buffer_scale: 2,
            viewport: Viewport::default(),
            ..viewport((1, 1))
        };

        assert_eq!(
            viewport((1000, 600)).pixels_a_point((1750, 1050)),
            (1.75, 1.75)
        );
        assert_eq!(scaled.pixels_a_point((800, 600)), (2.0, 2.0));
    }

    #[test]
    fn a_window_can_be_the_answer_to_a_keystroke() {
        assert!(answers_keystroke(&Committer::App("term".to_string())));
    }

    #[test]
    fn the_chromes_own_repaint_is_not_an_answer_to_a_keystroke() {
        // The chrome repaints for its own reasons; counting those would
        // misreport the wait.
        assert!(!answers_keystroke(&Committer::Chrome));
    }
}
