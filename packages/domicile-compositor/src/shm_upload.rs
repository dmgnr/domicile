//! An shm client's frame, drawn into a GPU buffer the engine can import.
//!
//! The copy is a GPU draw, not a `memcpy` into a mapping. NVIDIA's gbm will
//! not allocate a buffer that is both CPU-writable and renderable, and a linear
//! buffer imports into the browser but draws as the embedder's fallback (see
//! `packages/domicile-engine/scripts/spike-dmabuf.sh`). Every driver can sample
//! a buffer the GPU rendered into, so the client's pixels are uploaded as a
//! texture and drawn as a quad.

use std::os::fd::OwnedFd;
use std::sync::Mutex;

use smithay::backend::allocator::Modifier;
use smithay::backend::renderer::gles::{GlesError, GlesRenderer, GlesTexture};
use smithay::backend::renderer::sync::SyncPoint;
use smithay::backend::renderer::{Bind, Color32F, Frame, ImportMemWl as _, Renderer as _};
use smithay::reexports::wayland_server::protocol::{wl_buffer, wl_shm};
use smithay::utils::{Buffer as BufferCoords, Physical, Rectangle, Size, Transform};
use smithay::wayland::compositor::SurfaceData;
use smithay::wayland::shm::{shm_format_to_fourcc, with_buffer_contents};
use thiserror::Error;

use crate::engine::FOURCCS;
use crate::uploads::Shape;

/// Draws `texture` over all of `target`. Returns the draw's fence when
/// `fenced`, for an engine that waits on it; otherwise, or when the driver
/// cannot export one, waits for the draw to finish.
///
/// The engine reads the buffer from another process. Without a fence, a frame
/// submitted before the draw finishes shows the previous frame or a torn one.
pub fn copy<T>(
    renderer: &mut GlesRenderer,
    texture: &GlesTexture,
    target: &mut T,
    size: Size<i32, Physical>,
    fenced: bool,
) -> Result<Option<OwnedFd>, CopyError>
where
    GlesRenderer: Bind<T>,
{
    let whole = Rectangle::from_size(size);
    let source = Rectangle::from_size(Size::from((f64::from(size.w), f64::from(size.h))));
    let mut framebuffer = renderer.bind(target)?;
    let mut frame = renderer.render(&mut framebuffer, size, Transform::Normal)?;
    // The buffer is reused, so clear it before blending translucent pixels.
    frame.clear(Color32F::TRANSPARENT, &[whole])?;
    Frame::render_texture_from_to(
        &mut frame,
        texture,
        source,
        whole,
        &[whole],
        &[],
        Transform::Normal,
        1.0,
    )?;
    landed(frame.finish()?, fenced)
}

/// The fence `sync` exports, if `fenced` asks for one and the driver can
/// export it. Otherwise waits for `sync`.
fn landed(sync: SyncPoint, fenced: bool) -> Result<Option<OwnedFd>, CopyError> {
    match fenced.then(|| sync.export()).flatten() {
        Some(fence) => Ok(Some(fence)),
        None => {
            sync.wait().map_err(|_| CopyError::Interrupted)?;
            Ok(None)
        }
    }
}

/// The rectangles of a `size` buffer to upload into the surface's texture, in
/// Smithay's terms: empty uploads the whole buffer.
///
/// The client's `damage` is enough only when the texture holds the commit
/// before it.
pub fn uploaded(
    damage: Option<(i32, i32, i32, i32)>,
    texture_is_current: bool,
    size: (u32, u32),
) -> Vec<Rectangle<i32, BufferCoords>> {
    let (width, height) = (size.0 as i32, size.1 as i32);
    damage
        .filter(|_| texture_is_current)
        .map(|(x, y, w, h)| {
            let (left, top) = (x.clamp(0, width), y.clamp(0, height));
            let right = x.saturating_add(w).clamp(left, width);
            let bottom = y.saturating_add(h).clamp(top, height);
            Rectangle::new((left, top).into(), (right - left, bottom - top).into())
        })
        .into_iter()
        .collect()
}

/// Imports `buffer`, of `shape`, through the surface's cached texture.
///
/// Smithay reuses the cached texture whenever the size matches, keeping the
/// format it was made with: an opaque texture would hide a buffer's new
/// alpha. A new format at the same size skips the cache, until the size
/// changes and Smithay makes a texture in it.
pub fn import(
    renderer: &mut GlesRenderer,
    buffer: &wl_buffer::WlBuffer,
    states: &SurfaceData,
    shape: Shape,
    damage: &[Rectangle<i32, BufferCoords>],
) -> Result<GlesTexture, GlesError> {
    let cached = states
        .data_map
        .get_or_insert_threadsafe(|| Mutex::new(CachedTexture(None)));
    let mut cached = cached.lock().expect("never poisoned");
    through_the_cache(&mut cached.0, shape, |handed_over| {
        renderer.import_shm_buffer(buffer, handed_over.then_some(states), damage)
    })
}

/// The shape of the texture Smithay caches on a surface, as far as we have
/// handed it the cache.
struct CachedTexture(Option<Shape>);

/// Runs `import`, told whether Smithay may use the surface's texture, last
/// made as `cached`, for `shape`. Records the texture Smithay makes, once the
/// import succeeds: a failed one leaves Smithay's cache as it was.
fn through_the_cache<T, E>(
    cached: &mut Option<Shape>,
    shape: Shape,
    import: impl FnOnce(bool) -> Result<T, E>,
) -> Result<T, E> {
    let handed_over = match *cached {
        Some(held) if (held.width, held.height) == (shape.width, shape.height) => {
            held.fourcc == shape.fourcc
        }
        // Smithay makes a new texture, in this commit's format.
        _ => true,
    };
    let texture = import(handed_over)?;
    if handed_over {
        // Smithay made a texture in this shape, or reused one already in it.
        *cached = Some(shape);
    }
    Ok(texture)
}

/// The GPU buffer shape an shm buffer needs. `None` for a buffer that is not
/// shm, or whose format has no DRM fourcc.
pub fn shm_shape(buffer: &wl_buffer::WlBuffer) -> Option<Shape> {
    with_buffer_contents(buffer, |_, _, data| {
        shm_format_to_fourcc(data.format).map(|fourcc| Shape {
            width: data.width as u32,
            height: data.height as u32,
            fourcc: fourcc as u32,
        })
    })
    .ok()
    .flatten()
}

/// The modifiers the renderer can both render to and sample from for
/// `fourcc`. The browser samples the buffer on the same GPU.
///
/// Empty when the driver lists only the implicit modifier, which lets libgbm
/// pick the layout.
pub fn render_modifiers(renderer: &GlesRenderer, fourcc: u32) -> Vec<u64> {
    let context = renderer.egl_context();
    let sampled = context.dmabuf_texture_formats();
    context
        .dmabuf_render_formats()
        .iter()
        .filter(|format| {
            format.code as u32 == fourcc
                && format.modifier != Modifier::Invalid
                && sampled.contains(format)
        })
        .map(|format| u64::from(format.modifier))
        .collect()
}

/// The `wl_shm` formats to offer beyond the two every compositor offers:
/// those the engine imports, the renderer reads from memory, and the GPU can
/// copy into a buffer of: see [`upload_fourcc`].
pub fn shm_formats(renderer: &GlesRenderer) -> Vec<wl_shm::Format> {
    let drawn = drawn_formats(renderer);
    offered(renderer.shm_formats(), |fourcc| drawn.contains(&fourcc))
}

/// The fourcc of the GPU buffer a `fourcc` frame is copied into: see
/// [`drawn_as`]. `fourcc` itself when the GPU draws neither, so allocating
/// that buffer fails and says so.
pub fn upload_fourcc(renderer: &GlesRenderer, fourcc: u32) -> u32 {
    let drawn = drawn_formats(renderer);
    drawn_as(fourcc, |fourcc| drawn.contains(&fourcc)).unwrap_or(fourcc)
}

/// The fourccs the GPU can both draw into and sample.
fn drawn_formats(renderer: &GlesRenderer) -> Vec<u32> {
    let context = renderer.egl_context();
    let sampled = context.dmabuf_texture_formats();
    context
        .dmabuf_render_formats()
        .iter()
        .filter(|format| sampled.contains(format))
        .map(|format| format.code as u32)
        .collect()
}

/// The fourcc a `fourcc` frame is copied into: its own when the engine
/// imports it and `drawn` says the GPU draws into it, else its twin with
/// alpha. A frame without alpha draws opaque, so the twin's alpha comes out
/// whole. The engine imports no 10-bit or half-float format without alpha,
/// and some drivers draw into `ABGR2101010` but not `XBGR2101010`.
fn drawn_as(fourcc: u32, drawn: impl Fn(u32) -> bool) -> Option<u32> {
    let takes = |fourcc: u32| FOURCCS.contains(&fourcc) && drawn(fourcc);
    if takes(fourcc) {
        Some(fourcc)
    } else {
        alpha_twin(fourcc).filter(|twin| takes(*twin))
    }
}

/// The format with alpha that `fourcc`, a format without, pads.
fn alpha_twin(fourcc: u32) -> Option<u32> {
    match fourcc {
        0x3432_5258 => Some(0x3432_5241), // XRGB8888 -> ARGB8888
        0x3432_4258 => Some(0x3432_4241), // XBGR8888 -> ABGR8888
        0x3033_5258 => Some(0x3033_5241), // XRGB2101010 -> ARGB2101010
        0x3033_4258 => Some(0x3033_4241), // XBGR2101010 -> ABGR2101010
        0x4834_4258 => Some(0x4834_4241), // XBGR16161616F -> ABGR16161616F
        _ => None,
    }
}

/// The formats in `read` that the engine imports and the GPU can copy into a
/// buffer of, `drawn` saying which it draws into.
fn offered(
    read: impl IntoIterator<Item = wl_shm::Format>,
    drawn: impl Fn(u32) -> bool,
) -> Vec<wl_shm::Format> {
    read.into_iter()
        .filter(|format| {
            shm_format_to_fourcc(*format)
                .map(|fourcc| fourcc as u32)
                .and_then(|fourcc| drawn_as(fourcc, &drawn))
                .is_some()
        })
        .collect()
}

/// Why copying a frame into the buffer failed.
#[derive(Debug, Error)]
pub enum CopyError {
    #[error("the GPU would not draw the client's frame: {0}")]
    Gles(#[from] GlesError),
    #[error("the wait for the client's frame to land was interrupted")]
    Interrupted,
}

#[cfg(test)]
mod tests {
    use smithay::backend::allocator::Fourcc;
    use smithay::backend::renderer::gles::GlesRenderbuffer;
    use smithay::backend::renderer::{Bind as _, ExportMem as _, ImportMem as _, Offscreen as _};
    use smithay::utils::{Rectangle, Size};

    use crate::dmabuf_import::headless_renderer;

    use super::copy;

    /// Four opaque pixels in `Argb8888` byte order (B, G, R, A), one color per
    /// corner, so a flip or swizzle on either axis changes the result.
    const CORNERS: [u8; 16] = [
        0, 0, 255, 255, // top left: red
        0, 255, 0, 255, // top right: green
        255, 0, 0, 255, // bottom left: blue
        255, 255, 255, 255, // bottom right: white
    ];

    #[test]
    fn the_buffer_holds_the_clients_pixels_the_right_way_up() {
        let (mut renderer, _) = headless_renderer().expect("EGL: llvmpipe will do");
        let size = Size::from((2, 2));
        let texture = renderer
            .import_memory(&CORNERS, Fourcc::Argb8888, size, false)
            .expect("the pixels import");
        let mut target: GlesRenderbuffer = renderer
            .create_buffer(Fourcc::Argb8888, size)
            .expect("a renderbuffer");

        copy(
            &mut renderer,
            &texture,
            &mut target,
            Size::from((2, 2)),
            false,
        )
        .expect("the copy draws");

        let framebuffer = renderer.bind(&mut target).expect("binds");
        let mapping = renderer
            .copy_framebuffer(&framebuffer, Rectangle::from_size(size), Fourcc::Argb8888)
            .expect("reads back");
        drop(framebuffer);
        let pixels = renderer.map_texture(&mapping).expect("maps");
        assert_eq!(pixels, CORNERS);
    }

    /// Four `Abgr2101010` pixels whose channels an 8-bit copy would round:
    /// 1, 2 and 3 tenth-bit steps, and opaque.
    const TEN_BIT: [u32; 4] = [
        (3 << 30) | (3 << 20) | (2 << 10) | 1,
        (3 << 30) | (1 << 20) | (3 << 10) | 2,
        (3 << 30) | (2 << 20) | (1 << 10) | 3,
        (3 << 30) | (1021 << 20) | (1022 << 10) | 1023,
    ];

    #[test]
    fn a_10_bit_frame_keeps_its_10_bits() {
        let (mut renderer, _) = headless_renderer().expect("EGL: llvmpipe will do");
        let size = Size::from((2, 2));
        let bytes: Vec<u8> = TEN_BIT
            .iter()
            .flat_map(|pixel| pixel.to_le_bytes())
            .collect();
        let texture = renderer
            .import_memory(&bytes, Fourcc::Abgr2101010, size, false)
            .expect("the pixels import");
        let mut target: GlesRenderbuffer = renderer
            .create_buffer(Fourcc::Abgr2101010, size)
            .expect("a renderbuffer");

        copy(
            &mut renderer,
            &texture,
            &mut target,
            Size::from((2, 2)),
            false,
        )
        .expect("the copy draws");

        let framebuffer = renderer.bind(&mut target).expect("binds");
        let mapping = renderer
            .copy_framebuffer(
                &framebuffer,
                Rectangle::from_size(size),
                Fourcc::Abgr2101010,
            )
            .expect("reads back");
        drop(framebuffer);
        let pixels = renderer.map_texture(&mapping).expect("maps");
        assert_eq!(pixels, bytes);
    }

    #[test]
    fn a_frame_without_alpha_copied_into_its_alpha_twin_is_opaque() {
        let (mut renderer, _) = headless_renderer().expect("EGL: llvmpipe will do");
        let size = Size::from((1, 1));
        // #3366CC in 10 bits, its padding zero as clients leave it.
        let pixel: u32 = (819 << 20) | (409 << 10) | 205;
        let texture = renderer
            .import_memory(&pixel.to_le_bytes(), Fourcc::Xbgr2101010, size, false)
            .expect("the pixel imports");
        let mut target: GlesRenderbuffer = renderer
            .create_buffer(Fourcc::Abgr2101010, size)
            .expect("a renderbuffer");

        copy(
            &mut renderer,
            &texture,
            &mut target,
            Size::from((1, 1)),
            false,
        )
        .expect("the copy draws");

        let framebuffer = renderer.bind(&mut target).expect("binds");
        let mapping = renderer
            .copy_framebuffer(
                &framebuffer,
                Rectangle::from_size(size),
                Fourcc::Abgr2101010,
            )
            .expect("reads back");
        drop(framebuffer);
        let copied = renderer.map_texture(&mapping).expect("maps");
        assert_eq!(copied, ((3 << 30) | pixel).to_le_bytes());
    }

    mod drawn_as {
        use super::super::drawn_as;

        const XBGR2101010: u32 = 0x3033_4258;
        const ABGR2101010: u32 = 0x3033_4241;
        const XRGB8888: u32 = 0x3432_5258;
        const RGB565: u32 = 0x3631_4752;

        #[test]
        fn a_format_the_engine_imports_and_the_gpu_draws_into_is_drawn_as_itself() {
            assert_eq!(drawn_as(ABGR2101010, |_| true), Some(ABGR2101010));
            assert_eq!(drawn_as(XRGB8888, |_| true), Some(XRGB8888));
        }

        #[test]
        fn a_deep_format_without_alpha_is_drawn_as_its_alpha_twin_even_where_the_gpu_draws_it() {
            assert_eq!(drawn_as(XBGR2101010, |_| true), Some(ABGR2101010));
        }

        #[test]
        fn a_format_without_alpha_the_gpu_cannot_draw_is_drawn_as_its_alpha_twin() {
            assert_eq!(
                drawn_as(XBGR2101010, |fourcc| fourcc == ABGR2101010),
                Some(ABGR2101010)
            );
        }

        #[test]
        fn a_format_with_no_drawable_twin_is_not_drawn() {
            assert_eq!(drawn_as(XBGR2101010, |_| false), None);
            assert_eq!(drawn_as(RGB565, |fourcc| fourcc != RGB565), None);
        }
    }

    mod offered {
        use smithay::reexports::wayland_server::protocol::wl_shm::Format;

        use super::super::offered;

        const ABGR16161616F: u32 = 0x4834_4241;
        const ABGR2101010: u32 = 0x3033_4241;

        #[test]
        fn a_format_whose_alpha_twin_the_gpu_draws_is_offered() {
            let offered = offered([Format::Xbgr2101010], |fourcc| fourcc == ABGR2101010);

            assert_eq!(offered, [Format::Xbgr2101010]);
        }

        #[test]
        fn a_10_bit_format_the_gpu_draws_is_offered() {
            let offered = offered([Format::Xrgb8888, Format::Abgr2101010], |_| true);

            assert_eq!(offered, [Format::Xrgb8888, Format::Abgr2101010]);
        }

        #[test]
        fn a_format_the_engine_does_not_import_is_not_offered() {
            assert_eq!(offered([Format::Rgb565], |_| true), []);
        }

        #[test]
        fn a_format_the_gpu_cannot_draw_into_is_not_offered() {
            let offered = offered([Format::Abgr16161616f, Format::Argb8888], |fourcc| {
                fourcc != ABGR16161616F
            });

            assert_eq!(offered, [Format::Argb8888]);
        }
    }

    mod through_the_cache {
        use crate::uploads::Shape;

        use super::super::through_the_cache;

        const XRGB: u32 = 1;
        const ARGB: u32 = 2;

        fn shape(width: u32, fourcc: u32) -> Shape {
            Shape {
                width,
                height: 100,
                fourcc,
            }
        }

        /// Whether the import was handed the cache. It succeeds.
        fn handed_over(cached: &mut Option<Shape>, shape: Shape) -> bool {
            through_the_cache(cached, shape, Ok::<_, ()>).expect("it succeeds")
        }

        #[test]
        fn a_new_texture_takes_the_commits_format() {
            let mut cached = None;

            assert!(handed_over(&mut cached, shape(200, XRGB)));
            assert_eq!(cached, Some(shape(200, XRGB)));
        }

        #[test]
        fn a_new_format_at_the_same_size_skips_the_cache() {
            // Smithay would keep the opaque format for a translucent buffer.
            let mut cached = Some(shape(200, XRGB));

            assert!(!handed_over(&mut cached, shape(200, ARGB)));
            assert!(!handed_over(&mut cached, shape(200, ARGB)));
            assert!(handed_over(&mut cached, shape(200, XRGB)));
        }

        #[test]
        fn a_new_size_makes_a_texture_in_the_new_format() {
            let mut cached = Some(shape(200, XRGB));

            assert!(handed_over(&mut cached, shape(300, ARGB)));
            assert_eq!(cached, Some(shape(300, ARGB)));
        }

        // Smithay caches a new texture only once the import gets that far.
        #[test]
        fn a_failed_import_leaves_the_cache_as_it_was() {
            let mut cached = Some(shape(200, XRGB));

            assert_eq!(
                through_the_cache(&mut cached, shape(300, ARGB), |_| Err::<(), _>("no")),
                Err("no")
            );
            assert_eq!(cached, Some(shape(200, XRGB)));
        }
    }

    mod landed {
        use std::fs::File;
        use std::os::fd::{AsRawFd as _, OwnedFd};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        use smithay::backend::renderer::sync::{Fence, Interrupted, SyncPoint};

        use super::super::landed;

        /// A draw still on the GPU, whose fence exports `fd` if there is one.
        #[derive(Debug)]
        struct Drawing {
            fd: Mutex<Option<OwnedFd>>,
            waited: Arc<AtomicBool>,
        }

        impl Fence for Drawing {
            fn is_signaled(&self) -> bool {
                false
            }

            fn wait(&self) -> Result<(), Interrupted> {
                self.waited.store(true, Ordering::SeqCst);
                Ok(())
            }

            fn is_exportable(&self) -> bool {
                self.fd.lock().expect("never poisoned").is_some()
            }

            fn export(&self) -> Option<OwnedFd> {
                self.fd.lock().expect("never poisoned").take()
            }
        }

        /// The draw's sync point, and whether anything waited on it.
        fn drawing(fd: Option<OwnedFd>) -> (SyncPoint, Arc<AtomicBool>) {
            let waited = Arc::new(AtomicBool::new(false));
            let sync = SyncPoint::from(Drawing {
                fd: Mutex::new(fd),
                waited: waited.clone(),
            });
            (sync, waited)
        }

        fn an_fd() -> OwnedFd {
            File::open("/dev/null").expect("opens").into()
        }

        #[test]
        fn an_engine_that_takes_fences_gets_the_draws_fence_and_nothing_waits() {
            let fd = an_fd();
            let raw = fd.as_raw_fd();
            let (sync, waited) = drawing(Some(fd));

            let fence = landed(sync, true).expect("lands").expect("a fence");

            assert_eq!(fence.as_raw_fd(), raw);
            assert!(!waited.load(Ordering::SeqCst));
        }

        #[test]
        fn an_engine_that_takes_no_fence_waits_for_the_draw() {
            let (sync, waited) = drawing(Some(an_fd()));

            assert!(landed(sync, false).expect("lands").is_none());
            assert!(waited.load(Ordering::SeqCst));
        }

        // A driver without EGL_ANDROID_native_fence_sync.
        #[test]
        fn a_draw_whose_fence_cannot_be_exported_is_waited_for() {
            let (sync, waited) = drawing(None);

            assert!(landed(sync, true).expect("lands").is_none());
            assert!(waited.load(Ordering::SeqCst));
        }
    }

    mod uploaded {
        use smithay::utils::{Buffer as BufferCoords, Rectangle};

        use super::super::uploaded;

        fn rect(x: i32, y: i32, w: i32, h: i32) -> Rectangle<i32, BufferCoords> {
            Rectangle::new((x, y).into(), (w, h).into())
        }

        #[test]
        fn a_current_texture_takes_only_the_damage() {
            assert_eq!(
                uploaded(Some((10, 20, 5, 6)), true, (200, 100)),
                vec![rect(10, 20, 5, 6)]
            );
        }

        #[test]
        fn a_stale_texture_or_unknown_damage_takes_the_whole_buffer() {
            assert!(uploaded(Some((10, 20, 5, 6)), false, (200, 100)).is_empty());
            assert!(uploaded(None, true, (200, 100)).is_empty());
        }

        #[test]
        fn damage_past_the_buffer_is_cut_to_it() {
            // GL refuses a sub-image that leaves the texture.
            assert_eq!(
                uploaded(Some((0, 0, i32::MAX, i32::MAX)), true, (200, 100)),
                vec![rect(0, 0, 200, 100)]
            );
        }
    }
}
