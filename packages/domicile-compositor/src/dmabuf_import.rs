//! Picks the render device for `zwp_linux_dmabuf_v1` and checks that a
//! client's dmabuf imports.
//!
//! The engine composites client buffers; the compositor only tells clients
//! which GPU and formats to use and rejects buffers EGL cannot import. This is
//! thin glue over EGL and GLES, which cannot run without a GPU; the testable
//! conversion lives in `dmabuf_descriptor`.

use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::allocator::format::FormatSet;
use smithay::backend::allocator::Format;
use smithay::backend::egl::native::{EGLNativeDisplay, EGLPlatform, EGLSurfacelessDisplay};
use smithay::backend::egl::{ffi, EGLContext, EGLDevice, EGLDisplay};
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::renderer::ImportDma as _;

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use crate::gbm::Gbm;

/// The EGL library Smithay loads. Probed first so a missing GPU stack is an
/// error instead of a crash.
const EGL_LIBRARY: &str = "libEGL.so.1";

/// The DRM node of the renderer that imports client buffers.
///
/// Does not own the renderer: a texture belongs to the EGL context that made
/// it, so imports must use the renderer the compositor draws with. Taking it
/// by reference lets headless and presenting compositors share this code.
pub struct DmabufImporter {
    main_device: Option<u64>,
    node: Option<PathBuf>,
}

/// Why the GPU path is unavailable, or why a buffer could not be imported.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("{EGL_LIBRARY} is not loadable")]
    NoEgl(#[from] libloading::Error),
    #[error("EGL exposes no device to render on")]
    NoDevice,
    #[error("cannot list the DRM render nodes")]
    NoRenderNodes(#[source] std::io::Error),
    #[error("EGL operation failed")]
    Egl(#[from] smithay::backend::egl::Error),
    #[error("EGL could not destroy the validation image (error {0:#x})")]
    DestroyImage(i32),
    #[error("GLES failed to import or read back the buffer")]
    Gles(#[from] smithay::backend::renderer::gles::GlesError),
}

/// Creates an offscreen GLES renderer on the best EGL device, for a
/// compositor that is not presenting.
///
/// Fails without a working EGL; the compositor then advertises no dmabuf
/// global and `wl_shm` clients keep working.
pub fn headless_renderer() -> Result<(GlesRenderer, DmabufImporter), ImportError> {
    // Smithay panics if EGL is missing, so try loading it first.
    // SAFETY: this opens the same library Smithay opens next, running the
    // same initializers.
    unsafe { libloading::Library::new(EGL_LIBRARY) }?;
    let (display, node, main_device) = match EGLDevice::enumerate() {
        Ok(devices) => {
            let device =
                preferred_device(devices, EGLDevice::is_software).ok_or(ImportError::NoDevice)?;
            let main_device = drm_node(&device);
            let node = device
                .render_device_path()
                .or_else(|_| device.drm_device_path())
                .ok();
            tracing::debug!(device = ?node, main_device, "dmabuf import device");
            // SAFETY: the device comes from EGL's own enumeration, and the
            // display takes ownership of it.
            (unsafe { EGLDisplay::new(device) }?, node, main_device)
        }
        // NVIDIA's EGL offers the GBM platform but not
        // `EGL_EXT_device_enumeration`.
        Err(err) => {
            tracing::debug!(%err, "EGL cannot list devices; trying GBM on each render node");
            gbm_or_surfaceless_display(Path::new("/dev/dri"))?
        }
    };
    let context = EGLContext::new(&display)?;
    // SAFETY: the renderer is created, used and dropped on the Wayland
    // thread, which is where the context is made current.
    let renderer = unsafe { GlesRenderer::new(context) }?;
    Ok((renderer, DmabufImporter { main_device, node }))
}

/// An EGL display over libgbm on a render node in `dir`, with that node and its
/// device number, or a surfaceless one with neither when no node has GBM.
///
/// A VM whose only render node is not a GPU still gets a software renderer.
fn gbm_or_surfaceless_display(
    dir: &Path,
) -> Result<(EGLDisplay, Option<PathBuf>, Option<u64>), ImportError> {
    match gbm_display(dir) {
        Ok((display, node)) => {
            let main_device = device_number(&node);
            tracing::debug!(device = ?node, main_device, "dmabuf import device");
            Ok((display, Some(node), main_device))
        }
        Err(err) => {
            tracing::debug!(%err, "no render node has GBM; using surfaceless EGL");
            // SAFETY: a surfaceless display wraps no native handle.
            let display = unsafe { EGLDisplay::new(EGLSurfacelessDisplay) }?;
            Ok((display, None, None))
        }
    }
}

/// An EGL display over libgbm on the first render node in `dir` that has one,
/// and that node.
fn gbm_display(dir: &Path) -> Result<(EGLDisplay, PathBuf), ImportError> {
    for node in render_nodes(dir).map_err(ImportError::NoRenderNodes)? {
        let gbm = match Gbm::open(crate::gbm::LIBRARY, &node) {
            Ok(gbm) => gbm,
            Err(err) => {
                tracing::debug!(?node, %err, "no GBM device on this render node");
                continue;
            }
        };
        // SAFETY: the display keeps the device, and so its fd, alive for its
        // whole life.
        match unsafe { EGLDisplay::new(GbmDisplay(gbm)) } {
            Ok(display) => return Ok((display, node)),
            Err(err) => tracing::debug!(?node, %err, "EGL refuses this GBM device"),
        }
    }
    Err(ImportError::NoDevice)
}

/// The render nodes in `dir`, in order.
fn render_nodes(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut nodes = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with("renderD") {
            nodes.push(entry.path());
        }
    }
    nodes.sort();
    Ok(nodes)
}

/// A libgbm device as an EGL native display.
struct GbmDisplay(Gbm);

// SAFETY: a gbm device is not tied to the thread that made it, and the EGL
// display that owns this only uses it on the Wayland thread.
unsafe impl Send for GbmDisplay {}

impl EGLNativeDisplay for GbmDisplay {
    fn supported_platforms(&self) -> Vec<EGLPlatform<'_>> {
        let none = || vec![ffi::egl::NONE as ffi::EGLint];
        vec![
            EGLPlatform::new(
                ffi::egl::PLATFORM_GBM_KHR,
                "PLATFORM_GBM_KHR",
                self.0.raw(),
                none(),
                &["EGL_KHR_platform_gbm"],
            ),
            EGLPlatform::new(
                ffi::egl::PLATFORM_GBM_MESA,
                "PLATFORM_GBM_MESA",
                self.0.raw(),
                none(),
                &["EGL_MESA_platform_gbm"],
            ),
        ]
    }
}

impl DmabufImporter {
    /// The `dev_t` of the DRM node clients should allocate on, if any.
    ///
    /// Sent in `zwp_linux_dmabuf_v1` feedback. Domicile advertises no
    /// `wl_drm`, so feedback is the only way Mesa clients learn the device.
    pub fn main_device(&self) -> Option<u64> {
        self.main_device
    }

    /// The DRM node's path, for the compositor's own GPU buffers. `None` for
    /// a software rasterizer.
    pub fn node(&self) -> Option<&Path> {
        self.node.as_deref()
    }

    /// The formats to advertise on `zwp_linux_dmabuf_v1`: those both this
    /// renderer and the engine can import.
    pub fn formats(renderer: &GlesRenderer) -> FormatSet {
        advertisable(renderer.dmabuf_formats())
    }

    /// Checks a client's buffer before the client can commit it.
    ///
    /// The engine composites the buffer, so validation needs no cached texture.
    pub fn validate(renderer: &GlesRenderer, dmabuf: &Dmabuf) -> Result<(), ImportError> {
        let display = renderer.egl_context().display();
        let image = display.create_image_from_dmabuf(dmabuf)?;
        // SAFETY: the image belongs to this live display and has not been
        // handed to a texture or any other caller.
        if unsafe { ffi::egl::DestroyImageKHR(**display.get_display_handle(), image) }
            == ffi::egl::TRUE
        {
            Ok(())
        } else {
            // SAFETY: EGL is loaded and reports the error for this thread.
            Err(ImportError::DestroyImage(unsafe { ffi::egl::GetError() }))
        }
    }
}

/// The `dev_t` of the DRM node a device renders on. `None` for a software
/// rasterizer.
fn drm_node(device: &EGLDevice) -> Option<u64> {
    device
        .render_device_path()
        .or_else(|_| device.drm_device_path())
        .ok()
        .and_then(|path| device_number(&path))
}

/// The `dev_t` of the DRM node at `path`.
fn device_number(path: &Path) -> Option<u64> {
    match std::fs::metadata(path) {
        Ok(node) => Some(node.rdev()),
        Err(err) => {
            tracing::warn!(?path, %err, "cannot stat the render node");
            None
        }
    }
}

/// The formats in `imported` that the engine also accepts.
///
/// Advertising a format the engine refuses would let a client pick it and
/// then have every frame rejected.
fn advertisable(imported: impl IntoIterator<Item = Format>) -> FormatSet {
    imported
        .into_iter()
        .filter(|format| crate::engine::FOURCCS.contains(&(format.code as u32)))
        .collect()
}

/// Picks the first hardware device, or else a software rasterizer.
///
/// The software fallback keeps the dmabuf path working, and testable, on
/// machines without a GPU.
fn preferred_device<D>(
    devices: impl Iterator<Item = D>,
    is_software: impl Fn(&D) -> bool,
) -> Option<D> {
    let (hardware, software): (Vec<D>, Vec<D>) = devices.partition(|device| !is_software(device));
    hardware
        .into_iter()
        .next()
        .or_else(|| software.into_iter().next())
}

#[cfg(test)]
mod tests {
    use std::ffi::CStr;
    use std::fs::File;
    use std::os::fd::{FromRawFd as _, OwnedFd};

    use smithay::backend::allocator::dmabuf::{Dmabuf, DmabufFlags};
    use smithay::backend::allocator::{Format, Fourcc, Modifier};
    use smithay::backend::egl::{EGLContext, EGLDevice, EGLDisplay};
    use smithay::backend::renderer::gles::GlesRenderer;

    use super::{advertisable, gbm_or_surfaceless_display, render_nodes, DmabufImporter};

    fn format(code: Fourcc) -> Format {
        Format {
            code,
            modifier: Modifier::Linear,
        }
    }

    // A format the renderer imports but the engine refuses must not be
    // advertised: imv picked XR30 and none of its frames were drawn.
    #[test]
    fn only_what_the_engine_imports_is_advertised() {
        let renderer_imports = [
            format(Fourcc::Argb8888),
            format(Fourcc::Xrgb8888),
            format(Fourcc::Abgr8888),
            format(Fourcc::Xbgr8888),
            format(Fourcc::Xrgb2101010),
            format(Fourcc::Nv12),
        ];

        let mut advertised: Vec<Fourcc> = advertisable(renderer_imports)
            .iter()
            .map(|format| format.code)
            .collect();
        advertised.sort_by_key(|code| *code as u32);

        let mut expected = vec![
            Fourcc::Argb8888,
            Fourcc::Xrgb8888,
            Fourcc::Abgr8888,
            Fourcc::Xbgr8888,
        ];
        expected.sort_by_key(|code| *code as u32);
        assert_eq!(advertised, expected);
    }

    #[test]
    fn render_nodes_are_listed_in_order_without_primary_nodes() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["renderD129", "card0", "renderD128", "card1"] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }

        assert_eq!(
            render_nodes(dir.path()).unwrap(),
            [dir.path().join("renderD128"), dir.path().join("renderD129")]
        );
    }

    // A VM whose only render node libgbm refuses still renders, in software.
    #[test]
    fn no_gbm_render_node_falls_back_to_surfaceless_egl() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("renderD128"), "").unwrap();

        let (_display, node, main_device) = gbm_or_surfaceless_display(dir.path()).unwrap();

        assert_eq!((node, main_device), (None, None));
    }

    #[test]
    fn a_missing_dri_directory_is_an_error() {
        assert!(render_nodes(std::path::Path::new("/nonexistent/dri")).is_err());
    }

    /// A 2×2 `Argb8888` dmabuf over a new memfd named `name`, which llvmpipe
    /// imports by mapping it.
    fn dmabuf(name: &CStr) -> Dmabuf {
        // SAFETY: a valid name, and flags the kernel defines.
        let raw = unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC) };
        assert!(
            raw >= 0,
            "memfd_create: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: a new fd that nothing else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        File::from(fd.try_clone().expect("a memfd clones"))
            .set_len(4096)
            .expect("a memfd grows");
        let mut builder = Dmabuf::builder(
            (2, 2),
            Fourcc::Argb8888,
            Modifier::Linear,
            DmabufFlags::empty(),
        );
        builder.add_plane(fd, 0, 0, 8);
        builder.build().expect("one plane builds")
    }

    /// The fds and mappings in this process of the memfd named `name`.
    fn holds_on(name: &str) -> usize {
        let fds = std::fs::read_dir("/proc/self/fd")
            .expect("lists fds")
            .filter_map(|entry| std::fs::read_link(entry.expect("an fd").path()).ok())
            .filter(|target| target.to_string_lossy().contains(name))
            .count();
        let maps = std::fs::read_to_string("/proc/self/maps")
            .expect("reads maps")
            .lines()
            .filter(|line| line.contains(name))
            .count();
        fds + maps
    }

    #[test]
    fn validation_does_not_keep_an_import_for_a_live_client_buffer() {
        let software = EGLDevice::enumerate()
            .expect("lists EGL devices")
            .find(EGLDevice::is_software)
            .expect("Mesa exposes a software EGL device for importing a memfd");
        // SAFETY: this device comes from EGL's own enumeration.
        let display = unsafe { EGLDisplay::new(software) }.expect("opens software EGL display");
        let context = EGLContext::new(&display).expect("creates software EGL context");
        // SAFETY: the test creates, uses, and drops the renderer on this thread.
        let renderer = unsafe { GlesRenderer::new(context) }.expect("creates software renderer");
        let buffer = dmabuf(c"domicile-validation-only-buffer");
        let client_holds = holds_on("domicile-validation-only-buffer");

        DmabufImporter::validate(&renderer, &buffer).expect("the buffer imports");

        assert_eq!(holds_on("domicile-validation-only-buffer"), client_holds);
    }
}
