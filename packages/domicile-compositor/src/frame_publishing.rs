//! Handing a committed app frame to the engine: its dmabuf, or a copy of its shm
//! buffer (see `crate::uploads`), on the GPU or in memory for an engine on the
//! CPU (see `crate::memory_frames`).

use std::os::fd::OwnedFd;
use std::time::Instant;

use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::allocator::Buffer as _;
use smithay::reexports::wayland_server::protocol::{wl_buffer, wl_surface::WlSurface};
use smithay::wayland::compositor::with_states;
use smithay::wayland::dmabuf::get_dmabuf;
use smithay::wayland::shm::with_buffer_contents;
use tracing::error;

use crate::buffer_transform::Sampled;
use crate::dmabuf_descriptor::descriptor_from;
use crate::engine_session::{EngineSession, Remapped, Submission, Submitted};
use crate::frame_descriptor::FrameDescriptor;
use crate::frame_pacing::Paced;
use crate::memory_frames::{MemoryError, MemoryFrame};
use crate::shm_upload::{render_modifiers, shm_shape, upload_fourcc, CopyError};
use crate::surface_commit::{committed_buffer, CommittedBuffer, Mapping};
use crate::uploads::{Shape, UploadId, Uploads};
use crate::DomicileCompositor;
use crate::{casting, engine_damage, gbm, shm_upload};

/// What became of a committed app frame. See
/// [`DomicileCompositor::publish_frame`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Published {
    /// The engine did not take it; the window keeps its previous frame.
    NotShown,
    /// The engine samples the client's dmabuf directly, so viz owns it until
    /// released.
    Held,
    /// The engine took a copy, uploaded as `fourcc`, so the client's buffer
    /// is already free.
    Copied { fourcc: u32 },
    /// The frame waits for a page to embed the window (see `engine_waiting`)
    /// or for its buffer's import (see `engine_imports`). `held` is as in
    /// [`Published::Held`].
    Waiting { held: bool },
}

/// An app's commit with a buffer, as [`DomicileCompositor::publish_frame`]
/// shows it.
pub struct Commit<'a> {
    pub surface: &'a WlSurface,
    pub buffer: &'a wl_buffer::WlBuffer,
    pub sampled: Sampled,
    /// The box to show it at. See [`crate::configure_answers`].
    pub at_box: u64,
    /// That box's size in device pixels, if the compositor knows it.
    pub box_size: Option<(u32, u32)>,
    /// The client's damage in buffer pixels, `(x, y, width, height)`. `None`
    /// when unknown or not exact.
    pub damage: Option<(i32, i32, i32, i32)>,
}

/// A compositor buffer an shm frame is copied into.
#[derive(Debug)]
pub enum Upload {
    /// On the GPU, for an engine that composites there.
    Gpu(Dmabuf),
    /// In memory, for an engine on the CPU.
    Memory(MemoryFrame),
}

impl Upload {
    /// The buffer for the engine. Borrows its fds.
    pub fn describe(&self) -> FrameDescriptor {
        match self {
            Upload::Gpu(dmabuf) => FrameDescriptor::Dmabuf(descriptor_from(dmabuf)),
            Upload::Memory(frame) => FrameDescriptor::Shm(frame.describe()),
        }
    }

    fn size(&self) -> (u32, u32) {
        match self {
            Upload::Gpu(dmabuf) => (dmabuf.width(), dmabuf.height()),
            Upload::Memory(frame) => frame.size(),
        }
    }

    fn dmabuf(&self) -> Option<&Dmabuf> {
        match self {
            Upload::Gpu(dmabuf) => Some(dmabuf),
            Upload::Memory(_) => None,
        }
    }
}

/// An shm frame in one of the compositor's buffers, ready to submit.
struct CopiedFrame {
    id: UploadId,
    descriptor: FrameDescriptor,
    /// The format the surface's texture now holds it in.
    fourcc: u32,
    /// Signals when the copy lands. `None` when the copy was waited for.
    fence: Option<OwnedFd>,
}

/// Why an shm client's frame could not be shown. Logged once per client.
#[derive(Debug, thiserror::Error)]
enum ShmRefused {
    #[error(
        "this client drew into shared memory, and there is no EGL renderer to copy its \
         frames to the GPU with"
    )]
    NoRenderer,
    #[error(
        "this client drew into shared memory, and there is no libgbm device to allocate the \
         GPU buffers its frames are copied into — the startup log says why"
    )]
    NoAllocator,
    #[error(
        "this client's shared-memory buffer could not be read, or is in a format with no DRM \
         equivalent"
    )]
    Unreadable,
    #[error("could not allocate a GPU buffer to copy this client's frame into: {0}")]
    Allocation(#[from] gbm::AllocationError),
    #[error("could not copy this client's frame to the GPU: {0}")]
    Copy(#[from] CopyError),
    #[error(
        "this client drew into shared memory, the engine composites on the CPU, and this \
         engine is too old to take a window in memory"
    )]
    NoMemoryImport,
    #[error("could not put this client's frame in memory for the engine: {0}")]
    Memory(#[from] MemoryError),
}

impl DomicileCompositor {
    /// Show this app's frame and report what happened to the client's buffer.
    ///
    /// [`Published::Held`] means viz is sampling the client's dmabuf and the
    /// caller must not release it. Otherwise the caller releases it.
    ///
    /// A dmabuf reaches the engine as it is; shm frames are copied first (see
    /// [`crate::uploads`]).
    pub fn publish_frame(&mut self, app_id: &str, commit: &Commit) -> Published {
        let Some(committed) = committed_buffer(commit.buffer) else {
            return Published::NotShown;
        };
        if self.engine.is_none() {
            return Published::NotShown;
        }
        let damage = self.shown.damage(
            app_id,
            engine_damage::Next {
                damage: commit.damage,
                at_box: commit.at_box,
                box_size: commit.box_size,
                crop: commit.sampled.crop,
                buffer: committed.size(),
            },
        );
        let published = match &committed {
            CommittedBuffer::Gpu(dmabuf) => {
                let published = self.submit_to_the_engine(
                    app_id,
                    Submitted::Client(commit.buffer.clone()),
                    &FrameDescriptor::Dmabuf(descriptor_from(dmabuf)),
                    None,
                    commit,
                    damage,
                    Published::Held,
                );
                if published != Published::NotShown {
                    self.casting.shown(
                        app_id,
                        casting::Shown {
                            dmabuf: dmabuf.clone(),
                            sampled: commit.sampled,
                        },
                    );
                }
                published
            }
            CommittedBuffer::Pixels { .. } => self.publish_shm_frame(app_id, commit, damage),
        };
        if matches!(published, Published::Held | Published::Copied { .. }) {
            self.frame_shown(app_id);
        }
        published
    }

    /// Show `app_id`'s frame again as `mapping` maps its buffer, at the box
    /// `at_box` names, for a commit that attached no buffer and answers a
    /// configure of `configured` size. See [`EngineSession::remap`].
    ///
    /// Returns the frame the engine will report, or `None` if the engine shows
    /// nothing new.
    pub fn remap_frame(
        &mut self,
        app_id: &str,
        mapping: &Mapping,
        configured: Option<(i32, i32)>,
        at_box: u64,
    ) -> Option<Paced> {
        let session = self.engine.as_mut()?;
        let uploads = &self.uploads;
        let sample = |buffer: &Submitted| {
            size_of(buffer, uploads).map(|size| mapping.sampled(size, configured))
        };
        // Before the submit, which numbers this commit's frame.
        let last = session.frame_of(app_id);
        let (buffer, paced) = match session.remap(app_id, &sample, at_box, Instant::now()) {
            Remapped::Taken { buffer, frame } => {
                (buffer, Paced::Submitted(app_id.to_owned(), frame))
            }
            Remapped::Waiting { buffer } => (buffer, Paced::Held(app_id.to_owned())),
            Remapped::Unchanged => return None,
        };
        self.presentations.committed(app_id, at_box, last);
        // The client's next damage is relative to a frame mapped otherwise.
        self.shown.missed(app_id);
        let size = size_of(&buffer, &self.uploads).expect("the engine holds what it shows");
        let sampled = mapping.sampled(size, configured);
        // A cast reads dmabufs, so it misses a window in memory.
        if let Some(dmabuf) = dmabuf_of(&buffer, &self.uploads) {
            self.casting
                .shown(app_id, casting::Shown { dmabuf, sampled });
        }
        Some(paced)
    }

    /// Submit `submitted` as `app_id`'s frame, damaging `damage` (see
    /// [`crate::engine_damage`]). Returns `shown` if the engine took it,
    /// [`Published::NotShown`] if not.
    #[allow(clippy::too_many_arguments)] // One frame's worth.
    fn submit_to_the_engine(
        &mut self,
        app_id: &str,
        submitted: Submitted,
        descriptor: &FrameDescriptor,
        fence: Option<OwnedFd>,
        commit: &Commit,
        damage: (i32, i32, i32, i32),
        shown: Published,
    ) -> Published {
        let Some(session) = self.engine.as_mut() else {
            return Published::NotShown;
        };
        session.describe(
            app_id,
            crate::color_management::committed_color(commit.surface),
        );
        let submission = session.submit(
            app_id,
            submitted,
            descriptor,
            commit.sampled,
            damage,
            commit.at_box,
            fence,
            Instant::now(),
        );
        self.arm_the_hold_deadline();
        match submission {
            Submission::Taken { replaced } => {
                if let Some(buffer) = replaced {
                    self.returned(buffer);
                }
                shown
            }
            Submission::Waiting { replaced } => {
                if let Some(buffer) = replaced {
                    self.returned(buffer);
                }
                Published::Waiting {
                    held: shown == Published::Held,
                }
            }
            Submission::Refused => Published::NotShown,
        }
    }

    /// Copy an shm client's frame into a compositor buffer and submit that.
    ///
    /// Never [`Published::Held`]: the client's buffer is free once copied. A
    /// failed copy is logged once per client, so a blank window always has an
    /// explanation.
    fn publish_shm_frame(
        &mut self,
        app_id: &str,
        commit: &Commit,
        damage: (i32, i32, i32, i32),
    ) -> Published {
        let copied = match self.copy_shm_frame(app_id, commit) {
            Ok(copied) => copied,
            Err(why) => {
                if self.shm_refused.first(app_id) {
                    error!(app_id, %why, "this client's window will be blank");
                }
                return Published::NotShown;
            }
        };
        let published = self.submit_to_the_engine(
            app_id,
            Submitted::Upload(copied.id),
            &copied.descriptor,
            copied.fence,
            commit,
            damage,
            Published::Copied {
                fourcc: copied.fourcc,
            },
        );
        if published == Published::NotShown {
            // Never reached viz, so nothing will release it.
            self.uploads.give_back(copied.id);
        } else if let Some(dmabuf) = self
            .uploads
            .get(copied.id)
            .expect("a buffer the engine holds is there")
            .dmabuf()
        {
            // A cast reads dmabufs, so it misses a window in memory.
            self.casting.shown(
                app_id,
                casting::Shown {
                    dmabuf: dmabuf.clone(),
                    sampled: commit.sampled,
                },
            );
        }
        published
    }

    /// Follows how the engine composites: windows go to it in memory while it
    /// composites in software, as after its GPU process falls back.
    ///
    /// Going to memory withdraws `zwp_linux_dmabuf_v1`, so clients that
    /// connect later draw in memory too. A client already drawing in dmabufs
    /// stays blank. Falling back is a bug, so it is logged as an error and the
    /// person is told. Chromium never returns to GPU
    /// compositing, so the global is not put back.
    pub fn engine_composites(&mut self, in_memory: bool) {
        if in_memory == self.software_compositing {
            return;
        }
        if in_memory {
            error!(
                "the engine's GPU process fell back to software compositing, a bug in Domicile, \
                 Chromium or the graphics driver; windows already drawing on the GPU stay blank"
            );
            self.hub
                .notifications
                .get()
                .expect("the notification server is handed to the hub before the engine starts")
                .warn_that_graphics_failed();
        } else {
            error!(
                "the engine went back to GPU compositing, which Chromium never does; \
                 zwp_linux_dmabuf_v1 stays withdrawn"
            );
        }
        self.software_compositing = in_memory;
        if let (true, Some(global)) = (in_memory, &self.dmabuf_global) {
            self.dmabuf_state
                .disable_global::<DomicileCompositor>(&self.display_handle, global);
        }
    }

    /// Copy the commit's buffer into a free buffer of `app_id`'s: on the GPU,
    /// or in memory for an engine on the CPU.
    ///
    /// The buffer comes back taken; the caller gives it back if the engine
    /// does not take it.
    fn copy_shm_frame(&mut self, app_id: &str, commit: &Commit) -> Result<CopiedFrame, ShmRefused> {
        match self.software_compositing {
            true => self.copy_shm_frame_to_memory(app_id, commit),
            false => self.copy_shm_frame_to_the_gpu(app_id, commit),
        }
    }

    /// Copy the commit's buffer into one of `app_id`'s memfds, whole. See
    /// [`crate::memory_frames`].
    fn copy_shm_frame_to_memory(
        &mut self,
        app_id: &str,
        commit: &Commit,
    ) -> Result<CopiedFrame, ShmRefused> {
        if !self.engine.as_ref().is_some_and(EngineSession::imports_shm) {
            return Err(ShmRefused::NoMemoryImport);
        }
        let shape = shm_shape(commit.buffer).ok_or(ShmRefused::Unreadable)?;
        let taken = self.uploads.take(
            app_id,
            shape,
            |upload| matches!(upload, Upload::Memory(_)),
            |shape| MemoryFrame::allocate(shape).map(Upload::Memory),
        )?;
        they_were_dropped(self.engine.as_mut(), &taken.dropped);
        let Some(Upload::Memory(target)) = self.uploads.get_mut(taken.id) else {
            unreachable!("an engine on the CPU has only memory frames")
        };
        let copied = with_buffer_contents(commit.buffer, |pool, length, data| {
            // SAFETY: Smithay maps the client's pool, `length` bytes, for the
            // call.
            let pool = unsafe { std::slice::from_raw_parts(pool, length) };
            target.copy_from(pool, data.offset as usize, data.stride as usize)
        });
        let descriptor = FrameDescriptor::Shm(target.describe());
        let refused = match copied {
            Ok(Ok(())) => {
                return Ok(CopiedFrame {
                    id: taken.id,
                    descriptor,
                    fourcc: shape.fourcc,
                    fence: None,
                })
            }
            Ok(Err(err)) => ShmRefused::Memory(err),
            Err(_) => ShmRefused::Unreadable,
        };
        self.uploads.give_back(taken.id);
        Err(refused)
    }

    /// Copy the commit's buffer into a free GPU buffer of `app_id`'s.
    ///
    /// The client's pixels reach the GPU through a texture kept on the
    /// surface, so only the damage is uploaded while it holds the previous
    /// commit.
    ///
    /// An engine that takes fences gets the copy's, so this thread does not
    /// wait for the GPU.
    fn copy_shm_frame_to_the_gpu(
        &mut self,
        app_id: &str,
        commit: &Commit,
    ) -> Result<CopiedFrame, ShmRefused> {
        let fenced = self
            .engine
            .as_ref()
            .is_some_and(EngineSession::takes_fences);
        let gpu = self.gpu.as_mut().ok_or(ShmRefused::NoRenderer)?;
        let gbm = gpu.gbm.as_ref().ok_or(ShmRefused::NoAllocator)?;
        let shape = shm_shape(commit.buffer).ok_or(ShmRefused::Unreadable)?;
        let drawn = Shape {
            fourcc: upload_fourcc(&gpu.renderer, shape.fourcc),
            ..shape
        };
        let modifiers = render_modifiers(&gpu.renderer, drawn.fourcc);
        let taken = self.uploads.take(
            app_id,
            drawn,
            |upload| matches!(upload, Upload::Gpu(_)),
            |shape| gbm.allocate(shape, &modifiers).map(Upload::Gpu),
        )?;
        they_were_dropped(self.engine.as_mut(), &taken.dropped);
        let Some(Upload::Gpu(target)) = self.uploads.get_mut(taken.id) else {
            unreachable!("an engine on the GPU has only GPU buffers")
        };
        let size = (shape.width as i32, shape.height as i32).into();
        let damage = shm_upload::uploaded(
            commit.damage,
            self.shown.texture_is_current(app_id, shape.fourcc),
            (shape.width, shape.height),
        );
        let copied = with_states(commit.surface, |states| {
            shm_upload::import(&mut gpu.renderer, commit.buffer, states, shape, &damage)
        })
        .map_err(CopyError::from)
        .and_then(|texture| shm_upload::copy(&mut gpu.renderer, &texture, target, size, fenced));
        match copied {
            Ok(fence) => Ok(CopiedFrame {
                id: taken.id,
                descriptor: FrameDescriptor::Dmabuf(descriptor_from(target)),
                fourcc: shape.fourcc,
                fence,
            }),
            Err(err) => {
                self.uploads.give_back(taken.id);
                Err(ShmRefused::Copy(err))
            }
        }
    }
}

/// Tells the engine to forget buffers [`Uploads::take`] dropped.
fn they_were_dropped(engine: Option<&mut EngineSession>, dropped: &[UploadId]) {
    if let Some(session) = engine {
        for dropped in dropped {
            session.upload_dropped(*dropped);
        }
    }
}

/// The dmabuf behind a submitted buffer: the client's, or the compositor's
/// copy of its shm frame on the GPU. `None` for a frame in memory.
fn dmabuf_of(buffer: &Submitted, uploads: &Uploads<Upload>) -> Option<Dmabuf> {
    match buffer {
        Submitted::Client(buffer) => get_dmabuf(buffer).ok().cloned(),
        Submitted::Upload(id) => uploads.get(*id).and_then(Upload::dmabuf).cloned(),
    }
}

/// The size of a submitted buffer.
fn size_of(buffer: &Submitted, uploads: &Uploads<Upload>) -> Option<(u32, u32)> {
    match buffer {
        Submitted::Client(buffer) => get_dmabuf(buffer)
            .ok()
            .map(|dmabuf| (dmabuf.width(), dmabuf.height())),
        Submitted::Upload(id) => uploads.get(*id).map(Upload::size),
    }
}
