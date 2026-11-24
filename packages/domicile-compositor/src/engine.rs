//! Bindings to `libdomicile_engine.so`, the forked engine's C ABI.
//!
//! The compositor submits client dmabufs to viz through this. See
//! `docs/architecture/ENGINE-FORK.md#the-c-abi` and `packages/domicile-engine`.
//!
//! The library is loaded with `dlopen` so `cargo build` does not need a
//! Chromium build. A missing library is still an error, never a silent
//! fallback.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CString, NulError};
use std::os::fd::{AsRawFd as _, BorrowedFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::buffer_transform::Sampled;
use crate::dmabuf_descriptor::DmabufDescriptor;
use crate::eis::DeskInput;
use domicile_config::{Desk, Transform};
use domicile_host::clipboard::{Contents, TEXT_MIMES};
use domicile_protocol::{InputConnection, InputKind, ListedInput, Scale};
use libloading::{Library, Symbol};
use smithay::utils::Transform as BufferTransform;
use thiserror::Error;

/// The default library name, looked up on `LD_LIBRARY_PATH`.
pub const LIBRARY: &str = "libdomicile_engine.so";

/// A surface, as the engine names one. Never zero.
pub type SurfaceId = u32;

/// An imported buffer, as the engine names one. Never zero.
pub type BufferId = u64;

/// Names one import in [`Engine::import_in_the_background`], so its answer
/// can be matched to it.
pub type Request = u64;

/// A display capture, as the engine names one. Never zero.
pub type CaptureId = u32;

/// Why the engine could not be reached. Messages name the library, because
/// the usual cause is that it was never built.
#[derive(Debug, Error)]
pub enum EngineError {
    #[error("could not load {path} ({LIBRARY} for the forked engine): {source}. It is built by packages/domicile-engine/scripts/build.sh and is not on this machine unless that has been run")]
    Library {
        path: PathBuf,
        #[source]
        source: libloading::Error,
    },

    #[error("{path} loaded but has no {symbol}: it is not {LIBRARY}, or it is an older one than this compositor was built against")]
    Symbol {
        path: PathBuf,
        symbol: &'static str,
        #[source]
        source: libloading::Error,
    },

    #[error("{LIBRARY} would not join the browser at {socket}: the engine is not running, or it was started without --domicile-broker-socket={socket}")]
    Connect { socket: PathBuf },

    #[error("the browser brokered no frame sink for {app_id}")]
    NoFrameSink { app_id: String },

    #[error("the browser shows display {display} in no window, so it cannot be captured")]
    NoCapture { display: i64 },

    #[error(
        "the browser has no page drawn for browser window {window:?}, so it cannot be captured"
    )]
    NoBrowserWindowCapture { window: String },

    #[error("a path the engine has to be told contains a nul byte: {0}")]
    Path(#[from] NulError),
}

/// `DomicileSubsurface`: one of a surface's subsurfaces, in logical pixels
/// from the top left of the surface's crop.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Subsurface {
    pub surface: SurfaceId,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Nonzero when it is drawn over the surface, zero when under it.
    pub above: u8,
}

/// One plane of a client's dmabuf, from `zwp_linux_buffer_params_v1.add`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Plane {
    pub fd: c_int,
    pub offset: u32,
    pub stride: u32,
}

/// The most planes `zwp_linux_dmabuf_v1` and `DomicileDmabuf` allow.
pub const MAX_PLANES: usize = 4;

/// The DRM fourccs the engine imports, matching `FormatFromFourcc` in
/// `packages/domicile-engine/src/components/domicile/browser/brokered_frame_sink.cc`.
/// `packages/domicile-engine/tests/test-the-engines-fourccs-agree.sh` checks the two lists match.
pub const FOURCCS: [u32; 7] = [
    0x3432_5241, // DRM_FORMAT_ARGB8888
    0x3432_5258, // DRM_FORMAT_XRGB8888
    0x3432_4241, // DRM_FORMAT_ABGR8888
    0x3432_4258, // DRM_FORMAT_XBGR8888
    0x3033_5241, // DRM_FORMAT_ARGB2101010
    0x3033_4241, // DRM_FORMAT_ABGR2101010
    0x4834_4241, // DRM_FORMAT_ABGR16161616F
];

/// `DomicileShmBuffer`: a window in shared memory, for an engine that
/// composites on the CPU. One plane at offset 0. The fd is borrowed for the
/// call.
#[repr(C)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShmBuffer {
    pub fd: c_int,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub fourcc: u32,
}

/// `DomicileChromaticity`: a CIE 1931 xy chromaticity.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Chromaticity {
    pub x: f32,
    pub y: f32,
}

/// `DomicileColor`: how a surface's pixels encode color, from its
/// `wp_image_description_v1`. Luminances are in cd/m²; zero is unset. Built by
/// [`crate::color_management::Description::engine_color`].
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Color {
    /// `DOMICILE_PRIMARIES_*`.
    pub primaries: u32,
    /// `DOMICILE_TRANSFER_*`.
    pub transfer: u32,
    pub reference_luminance: f32,
    pub has_mastering: u32,
    pub mastering_red: Chromaticity,
    pub mastering_green: Chromaticity,
    pub mastering_blue: Chromaticity,
    pub mastering_white: Chromaticity,
    pub mastering_min_luminance: f32,
    pub mastering_max_luminance: f32,
    pub max_cll: f32,
    pub max_fall: f32,
}

/// `DomicileDmabuf`: a client's buffer. The fds are borrowed for the call.
#[repr(C)]
pub struct Dmabuf {
    pub width: u32,
    pub height: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub plane_count: u32,
    pub planes: [Plane; MAX_PLANES],
}

impl Dmabuf {
    /// Converts a descriptor to the ABI struct.
    ///
    /// `None` for no planes or more than [`MAX_PLANES`]. Truncating the planes
    /// would draw a corrupt window.
    pub fn from_descriptor(descriptor: &DmabufDescriptor) -> Option<Self> {
        if descriptor.planes.is_empty() || descriptor.planes.len() > MAX_PLANES {
            return None;
        }
        let mut planes = [Plane {
            fd: -1,
            offset: 0,
            stride: 0,
        }; MAX_PLANES];
        for (slot, plane) in planes.iter_mut().zip(&descriptor.planes) {
            *slot = Plane {
                fd: plane.fd,
                offset: plane.offset,
                stride: plane.stride,
            };
        }
        Some(Self {
            width: descriptor.width,
            height: descriptor.height,
            fourcc: descriptor.fourcc,
            modifier: descriptor.modifier,
            plane_count: descriptor.planes.len() as u32,
            planes,
        })
    }
}

/// One frame of a display capture, with fds of its own.
#[derive(Clone, Debug, PartialEq)]
pub struct CapturedFrame {
    pub pixels: CapturedPixels,
    pub size: (u32, u32),
    /// `DRM_FORMAT_ARGB8888` or `DRM_FORMAT_ABGR8888`.
    pub fourcc: u32,
    /// The part of the frame that shows the display. The engine letterboxes
    /// the rest when the display's aspect differs from the size asked for.
    pub content: (i32, i32, i32, i32),
    /// What changed since the previous frame. `None` is all of it.
    pub damage: Option<(i32, i32, i32, i32)>,
}

/// Where a captured frame's pixels are.
#[derive(Clone, Debug, PartialEq)]
pub enum CapturedPixels {
    /// The browser composites on the GPU.
    Dmabuf {
        modifier: u64,
        planes: Vec<CapturedPlane>,
    },
    /// The browser composites in software: rows `stride` bytes apart from the
    /// start of `fd`.
    Shm { fd: SharedFd, stride: u32 },
}

/// One plane of a captured dmabuf.
#[derive(Clone, Debug, PartialEq)]
pub struct CapturedPlane {
    pub fd: SharedFd,
    pub offset: u32,
    pub stride: u32,
}

/// An fd shared by the clones of an event. Equal only to itself.
#[derive(Clone, Debug)]
pub struct SharedFd(pub Arc<OwnedFd>);

impl PartialEq for SharedFd {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

/// A display the engine scans out on, as the engine reports it.
///
/// The engine holds DRM master, so on a tty this is the only source of display
/// information. See `docs/architecture/A-DESKTOP-ON-A-TTY.md#outputs` and
/// `docs/DISPLAYS.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Display {
    /// The engine's id. A monitor with a description is named `drm-<id>`.
    /// Derived from the EDID, so it is stable across hotplugs
    /// (`Screens::rearranged_into`).
    pub id: i64,
    /// `"<MAKE> <MODEL> <SERIAL>"` from the EDID, or empty if it has none.
    ///
    /// `output.profiles` entries match on this. MAKE is the EDID's
    /// three-letter PNP id (`DEL`); `Screens` expands it with
    /// `crate::pnp_ids`. Becomes the `wl_output` description. See
    /// `docs/DISPLAYS.md#monitor-names`.
    pub description: String,
    /// The kernel's name for its connector (`DP-1`, `HDMI-A-1`, `eDP-1`), or
    /// empty from an engine without `connected_displays`. Names a monitor with
    /// no description.
    pub connector: String,
    /// Its top-left corner, in the desktop the engine laid out.
    pub position: (i32, i32),
    /// The mode it is scanning out, in physical pixels: its native mode
    /// unless the layout asked for another.
    pub size: (u32, u32),
    /// The panel's size in millimeters, or `(0, 0)` if unreported.
    pub physical_mm: (i32, i32),
    /// The CRTC's refresh rate in mHz, or zero if unreported.
    pub refresh_mhz: i32,
    /// Every mode the monitor offers, or none from an engine without
    /// `moded_displays`, which cannot set one.
    pub modes: Vec<Mode>,
    /// Whether it scans out with a variable refresh rate, as the hardware
    /// says. Unsupported from an engine without `adaptive_displays`.
    pub adaptive_sync: AdaptiveSync,
    /// Whether it is driven in HDR10, and its panel's luminances.
    /// Unsupported from an engine without `hdr_displays`.
    pub hdr: Hdr,
}

/// Whether a monitor is driven in HDR10 (BT.2020 with PQ), and how bright its
/// panel gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Hdr {
    pub state: HdrState,
    /// The panel's peak luminance from its EDID, in cd/m², or zero if
    /// unreported.
    pub max_luminance: u32,
    /// The panel's frame-average peak, in cd/m², or zero if unreported.
    pub max_average_luminance: u32,
    /// The panel's black, in 0.0001 cd/m² as `wp_color_management_v1`
    /// states minimums, or zero if unreported.
    pub min_luminance: u32,
    /// While [`HdrState::On`], the luminance SDR content's white is shown
    /// at, in cd/m²; zero otherwise.
    pub sdr_white: u32,
}

/// Whether a monitor is driven in HDR10.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HdrState {
    /// Its EDID takes no PQ, or its connector cannot scan out in 10 bits.
    #[default]
    Unsupported,
    /// It can, and is not.
    Off,
    /// It is.
    On,
}

/// Whether a monitor scans out with a variable refresh rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AdaptiveSync {
    /// The monitor, its connector or its driver cannot.
    #[default]
    Unsupported,
    /// It can, and is not: not asked for, or the driver refused it.
    Off,
    /// It is.
    On,
}

/// A mode a monitor offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mode {
    /// In physical pixels.
    pub size: (u32, u32),
    /// In mHz, or zero if unreported.
    pub refresh_mhz: i32,
}

impl Display {
    /// Whether the compositor asked for it with
    /// [`Engine::configure_virtual_displays`], rather than a connector backing
    /// it.
    pub fn is_virtual(&self) -> bool {
        self.id & VirtualDisplay::ID_BIT != 0
    }
}

/// A monitor with no connector, which the desk extends onto and only a capture
/// shows. See `docs/CASTING-TO-TVS.md`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VirtualDisplay {
    /// Its [`Display::id`]; see [`VirtualDisplay::id_of`].
    pub id: i64,
    /// Its mode, in physical pixels.
    pub mode: (u32, u32),
    pub refresh_mhz: u32,
    /// Device pixels per logical pixel. Not the engine's: the compositor lays
    /// a scaled one out itself (`Screens::from_the_engine`).
    pub scale: Scale,
    /// Its name, such as the TV it is cast to. Becomes the display's
    /// description.
    pub name: String,
}

impl VirtualDisplay {
    /// The bit that tells a virtual display's id from a connector's.
    const ID_BIT: i64 = i64::MIN;

    /// The id of virtual display `number`, which the engine reports on
    /// connector `virtual-<number>`.
    pub fn id_of(number: u32) -> i64 {
        Self::ID_BIT | i64::from(number)
    }
}

/// How the compositor wants a connector driven: the config's answer to a
/// [`Display`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Connector {
    /// The display, by [`Display::id`].
    pub id: i64,
    /// Whether to light it at all.
    pub enabled: bool,
    /// The connector's position on the engine's desktop, in physical pixels.
    /// Needed for dark connectors too, since the engine still places them.
    pub origin: (i32, i32),
    /// The monitor's rotation. The engine rotates the window so the page lays
    /// out upright.
    pub transform: Transform,
    /// Device pixels per logical pixel, applied by the engine to the window.
    pub scale: f64,
    /// The display's place on the logical desktop, or `None` if dark. The
    /// engine moves the pointer between monitors by it.
    pub desk: Option<Desk>,
    /// The mode to scan out, in physical pixels, or `None` for the native
    /// one.
    pub mode: Option<(u32, u32)>,
    /// The refresh rate to scan out, in mHz: the nearest one the monitor
    /// offers is used. `None` for the native mode's, or the highest at a
    /// non-native `mode`.
    pub refresh_mhz: Option<u32>,
    /// Whether to scan out with a variable refresh rate where the monitor
    /// can. The engine tries again without it if the driver refuses.
    pub adaptive_sync: bool,
    /// Whether to drive it in HDR10 where the monitor takes it.
    pub hdr: bool,
    /// In HDR, the luminance to show SDR content's white at, in cd/m².
    pub sdr_white: u32,
}

/// A tablet or touchscreen and the display it covers: the config's
/// `input.pointers`, for the engine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pointer {
    /// The device's evdev name or `phys`.
    pub device: String,
    /// The display, by [`Display::id`].
    pub display: i64,
}

/// Names the box the engine showed last, in [`Engine::submit`].
pub const LAST_SHOWN_BOX: u64 = 0;
/// Names the page's newest box, in [`Engine::submit`].
pub const NEWEST_BOX: u64 = u64::MAX;

/// A message from the engine, and its Wayland equivalent.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// `xdg_toplevel.configure`: the page's layout box changed.
    ///
    /// `width` and `height` are in device pixels; `scale` is device pixels per
    /// CSS pixel. `scale` is `None` from an engine without
    /// `configure_at`.
    ///
    /// `number` names the box for [`Engine::submit`]. `None` from an engine
    /// without `configure_box`.
    ///
    /// `zoom` is the `<app>`'s CSS `zoom`: the client draws `zoom` times
    /// denser at a logical size `zoom` times smaller, so the box stays sharp.
    /// 1 from an engine without `configure_zoomed`.
    Configure {
        surface: SurfaceId,
        width: u32,
        height: u32,
        scale: Option<f64>,
        number: Option<u64>,
        zoom: f64,
    },
    /// `wl_buffer.release`: viz has stopped reading the dmabuf, so the client
    /// may reuse it.
    Released {
        surface: SurfaceId,
        buffer: BufferId,
    },
    /// A copy made in the browser, for the seat's clipboard.
    ///
    /// The engine is not a Wayland client of this compositor, so this is how
    /// its copies reach Wayland clients.
    Copied {
        clipboard: Clipboard,
        contents: Contents,
    },

    /// The full display list, primary first, for `wl_output`.
    ///
    /// Sent at startup and on every hotplug. A display missing from the list
    /// has been unplugged.
    Displays(Vec<Display>),

    /// How many entries each display's gamma ramp has, by [`Display::id`].
    /// A display it leaves out has no gamma. Sent just before each
    /// [`Event::Displays`], by an engine with `ramped_displays`.
    GammaSizes(HashMap<i64, u32>),

    /// A frame of a display capture. Release `frame` with
    /// [`Engine::release_captured`] once read; `Err` says why it could not be
    /// kept, and must be released too.
    Captured {
        capture: CaptureId,
        frame: u64,
        captured: Result<CapturedFrame, String>,
    },

    /// The browser ended a display capture, saying why when it failed. No
    /// frame of it follows.
    CaptureEnded {
        capture: CaptureId,
        why: Option<String>,
    },

    /// `wl_surface.frame`'s `done`: viz took `frame` and takes the next.
    /// Frames are numbered from 1 per submit, as
    /// `crate::engine_surfaces::Surfaces::submitted` counts them.
    FrameDone { surface: SurfaceId, frame: u64 },

    /// `wp_presentation_feedback` for `frame`. `None` if it was never shown.
    Presented {
        surface: SurfaceId,
        frame: u64,
        shown: Option<Shown>,
    },

    /// The answer to [`Engine::import_in_the_background`]: the buffer's id,
    /// or `None` if the browser refused it.
    Imported {
        surface: SurfaceId,
        request: Request,
        buffer: Option<BufferId>,
    },

    /// The browser went away. Nothing follows from this engine; the next
    /// page's hello comes from a new one. See [`crate::which_engine`].
    Disconnected,

    /// How the browser composites: `in_memory` while it composites in
    /// software, where it shows no dmabuf. Sent once the browser knows, and
    /// when its GPU process falls back.
    Compositing { in_memory: bool },

    /// The browser's windows, in the order they opened, for capture tools to
    /// list beside the native ones. Sent once the browser connects, and when a
    /// window opens, closes or changes its title. An older engine never sends
    /// it.
    BrowserWindows(Vec<BrowserWindow>),

    /// The keyboards, pointers and touch devices the engine reads, in the
    /// order it found them, for `domicile list-inputs`. Sent once the browser
    /// connects, and when one is plugged or unplugged. An older engine never
    /// sends it.
    InputDevices(Vec<ListedInput>),
}

/// One of the browser's windows: a page it holds, which the shell draws with
/// `<webview window>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserWindow {
    /// Its id, as [`Engine::start_browser_window_capture`] takes it.
    pub id: String,
    /// The page's title, or empty.
    pub title: String,
    /// The app window's id, or empty for any other window.
    pub app_id: String,
    /// The address it shows, or the one it is opening.
    pub url: String,
    /// Whether it is a private window.
    pub private: bool,
    /// The views it holds and shows, bottom first: an Electron app's
    /// `WebContentsView`s, which a shot of the window draws over its page.
    /// An older engine lists none.
    pub views: Vec<BrowserView>,
}

/// An Electron app's view a [`BrowserWindow`] holds: a page of its own,
/// placed by the app in the window's page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserView {
    /// Its id, as [`Engine::start_browser_window_capture`] takes it.
    pub id: String,
    /// Where it is in the window's page, in that page's CSS pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// When and how a frame reached the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    /// On `CLOCK_MONOTONIC`.
    pub time: Duration,
    /// The display's frame interval, if known.
    pub refresh: Option<Duration>,
    /// `wp_presentation_feedback.kind` bits.
    pub kind: u32,
}

/// `DOMICILE_PRESENTED_DISCARDED`.
const PRESENTED_DISCARDED: u32 = 0x8000_0000;

/// Which clipboard a copy is on. Crosses the ABI as [`Clipboard::as_raw`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clipboard {
    /// `wl_data_device`: Ctrl-C and Ctrl-V.
    Copy,
    /// `zwp_primary_selection_device_v1`: select and middle-click.
    Primary,
}

impl Clipboard {
    /// The ABI value, as `DomicileClipboard` in the C header defines it.
    fn as_raw(self) -> u32 {
        match self {
            Clipboard::Copy => 0,
            Clipboard::Primary => 1,
        }
    }
}

/// The clipboard an ABI value names.
///
/// Panics on an unknown value rather than guessing, which could overwrite the
/// user's clipboard.
fn clipboard_from(raw: u32) -> Clipboard {
    match raw {
        0 => Clipboard::Copy,
        1 => Clipboard::Primary,
        _ => panic!("the engine named a clipboard this compositor has no name for: {raw}"),
    }
}

#[repr(C)]
struct Callbacks {
    user_data: *mut c_void,
    configure: Option<extern "C" fn(*mut c_void, SurfaceId, u32, u32)>,
    released: Option<extern "C" fn(*mut c_void, SurfaceId, BufferId)>,
    displays: Option<extern "C" fn(*mut c_void, *const RawDisplay, u32)>,
    copied: Option<extern "C" fn(*mut c_void, u32, *const c_char, usize)>,
    configure_at: Option<extern "C" fn(*mut c_void, SurfaceId, u32, u32, f64)>,
    captured: Option<extern "C" fn(*mut c_void, CaptureId, u64, *const RawCapturedFrame)>,
    capture_ended: Option<extern "C" fn(*mut c_void, CaptureId)>,
    configure_box: Option<extern "C" fn(*mut c_void, SurfaceId, u32, u32, f64, u64)>,
    copied_items: Option<extern "C" fn(*mut c_void, u32, *const RawClipboardItem, u32)>,
    frame_done: Option<extern "C" fn(*mut c_void, SurfaceId, u64)>,
    presented: Option<extern "C" fn(*mut c_void, SurfaceId, u64, i64, i64, u32)>,
    imported: Option<extern "C" fn(*mut c_void, SurfaceId, Request, BufferId)>,
    connected_displays: Option<extern "C" fn(*mut c_void, *const RawConnectedDisplay, u32)>,
    disconnected: Option<extern "C" fn(*mut c_void)>,
    compositing: Option<extern "C" fn(*mut c_void, c_int)>,
    ramped_displays: Option<extern "C" fn(*mut c_void, *const RawRampedDisplay, u32)>,
    moded_displays: Option<extern "C" fn(*mut c_void, *const RawModedDisplay, u32)>,
    browser_windows: Option<extern "C" fn(*mut c_void, *const RawBrowserWindow, u32)>,
    adaptive_displays: Option<extern "C" fn(*mut c_void, *const RawAdaptiveDisplay, u32)>,
    configure_zoomed: Option<extern "C" fn(*mut c_void, SurfaceId, u32, u32, f64, f64, u64)>,
    hdr_displays: Option<extern "C" fn(*mut c_void, *const RawHdrDisplay, u32)>,
    listed_browser_windows: Option<extern "C" fn(*mut c_void, *const RawListedBrowserWindow, u32)>,
    input_devices: Option<extern "C" fn(*mut c_void, *const RawInputDevice, u32)>,
    capture_failed: Option<extern "C" fn(*mut c_void, CaptureId, *const c_char)>,
    viewed_browser_windows: Option<
        extern "C" fn(
            *mut c_void,
            *const RawListedBrowserWindow,
            u32,
            *const RawBrowserWindowView,
            u32,
        ),
    >,
}

/// `DomicileInputDevice`, laid out as in the C header. Its strings are
/// borrowed for the call it crosses in, and never null.
#[repr(C)]
struct RawInputDevice {
    name: *const c_char,
    sys_path: *const c_char,
    id: i32,
    vendor_id: u16,
    product_id: u16,
    /// A `DomicileInputDeviceKind`.
    kind: u8,
    /// A `DomicileInputDeviceConnection`.
    connection: u8,
}

/// `DomicileBrowserWindow`, laid out as in the C header. Its strings are
/// borrowed for the call it crosses in, and never null.
#[repr(C)]
struct RawBrowserWindow {
    id: *const c_char,
    title: *const c_char,
    app_id: *const c_char,
}

/// `DomicileListedBrowserWindow`, laid out as in the C header: a
/// [`RawBrowserWindow`] plus its address and whether it is private.
#[repr(C)]
struct RawListedBrowserWindow {
    id: *const c_char,
    title: *const c_char,
    app_id: *const c_char,
    url: *const c_char,
    off_the_record: u8,
}

/// `DomicileBrowserWindowView`, laid out as in the C header: a view the
/// window at index `window` of the same call holds.
#[repr(C)]
struct RawBrowserWindowView {
    id: *const c_char,
    window: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// `DomicileClipboardItem`, laid out as in the C header: one type a copy can be
/// pasted as. Borrowed for the call it crosses in.
#[repr(C)]
struct RawClipboardItem {
    /// A nul-terminated MIME type. Never null.
    mime_type: *const c_char,
    /// `length` bytes; null only when `length` is zero.
    data: *const u8,
    length: usize,
}

/// Contents as `DomicileClipboardItem`s, with the storage the records point
/// into.
struct Items {
    /// The MIME types the records name, kept alive for them.
    _mimes: Vec<CString>,
    records: Vec<RawClipboardItem>,
}

impl Items {
    /// One item per part of `contents`: the text once, under the first of
    /// [`TEXT_MIMES`], and the image under its type. Borrows `contents`'
    /// bytes.
    fn of(contents: &Contents) -> Items {
        let parts: Vec<(&str, &[u8])> = contents
            .text
            .iter()
            .map(|text| (TEXT_MIMES[0], text.as_bytes()))
            .chain(
                contents
                    .image
                    .iter()
                    .map(|image| (image.mime.as_str(), image.bytes.as_slice())),
            )
            .collect();
        let mimes: Vec<CString> = parts
            .iter()
            .map(|(mime, _)| {
                CString::new(*mime).expect("a MIME type read off a selection holds no nul")
            })
            .collect();
        let records = parts
            .iter()
            .zip(&mimes)
            .map(|((_, bytes), mime)| RawClipboardItem {
                mime_type: mime.as_ptr(),
                data: bytes.as_ptr(),
                length: bytes.len(),
            })
            .collect();
        Items {
            _mimes: mimes,
            records,
        }
    }

    fn raw(&self) -> &[RawClipboardItem] {
        &self.records
    }
}

/// The contents `items` describe, copied out of the borrowed records.
fn contents_from(items: &[RawClipboardItem]) -> Contents {
    Contents::from_offers(items.iter().map(|item| {
        assert!(
            !item.mime_type.is_null(),
            "the engine names the type of every item it copies"
        );
        // SAFETY: the ABI says `mime_type` is a nul-terminated string, valid
        // for this call.
        let mime = unsafe { std::ffi::CStr::from_ptr(item.mime_type) }
            .to_string_lossy()
            .into_owned();
        let bytes = if item.length == 0 {
            Vec::new()
        } else {
            // SAFETY: the ABI says `data` points at `length` bytes, valid
            // for this call.
            unsafe { std::slice::from_raw_parts(item.data, item.length) }.to_vec()
        };
        (mime, bytes)
    }))
}

/// The engine's opaque handle.
#[repr(C)]
struct Handle {
    _private: [u8; 0],
}

/// A loaded engine, connected to the browser.
///
/// Callbacks fire only inside [`Engine::dispatch`], on the calling thread, so
/// events are returned as a plain vector.
#[derive(Debug)]
pub struct Engine {
    handle: *mut Handle,
    events: Box<RefCell<Vec<Event>>>,
    library: Library,
    path: PathBuf,
    /// Whether the missing-crop warning was logged. Logged once because
    /// submit runs every frame.
    said_it_cannot_crop: Cell<bool>,
    /// Whether the missing `domicile_surface_submit_for_box` was logged.
    said_it_cannot_wait: Cell<bool>,
    /// Whether the missing `domicile_surface_submit_transformed` was logged.
    said_it_cannot_turn: Cell<bool>,
}

/// `DomicileDisplay`, laid out as in the C header. 48 bytes, including 4 of
/// tail padding.
// `Default` is for tests. Its null name is refused by `displays_from`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
struct RawDisplay {
    id: i64,
    /// The panel's name, borrowed for the callback. Never null; checked in
    /// [`displays_from`].
    name: *const std::ffi::c_char,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    physical_width_mm: i32,
    physical_height_mm: i32,
    refresh_mhz: i32,
}

/// `DomicileConnectedDisplay`, laid out as in the C header. 56 bytes, no
/// padding.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
struct RawConnectedDisplay {
    display: RawDisplay,
    /// The connector's name, borrowed for the callback. Never null; checked
    /// in [`connected_displays_from`].
    connector: *const std::ffi::c_char,
}

/// `DomicileRampedDisplay`, laid out as in the C header. 64 bytes, including
/// 4 of tail padding.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
struct RawRampedDisplay {
    connected: RawConnectedDisplay,
    gamma_size: u32,
}

/// `DomicileDisplayMode`, laid out as in the C header. 12 bytes, no padding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
struct RawMode {
    width: i32,
    height: i32,
    refresh_mhz: i32,
}

/// `DomicileModedDisplay`, laid out as in the C header. 80 bytes, including 4
/// of tail padding.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
struct RawModedDisplay {
    ramped: RawRampedDisplay,
    /// `mode_count` modes, borrowed for the callback. May be null when
    /// `mode_count` is zero.
    modes: *const RawMode,
    mode_count: u32,
}

/// `DomicileModedLayout`, laid out as in the C header. 64 bytes, including 4
/// of tail padding.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
struct RawModedLayout {
    layout: RawLayout,
    /// Zero for the native mode.
    mode_width: i32,
    mode_height: i32,
    /// Zero for the default rate.
    refresh_mhz: i32,
}

/// `DomicileAdaptiveDisplay`, laid out as in the C header. 88 bytes,
/// including 4 of tail padding.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
struct RawAdaptiveDisplay {
    moded: RawModedDisplay,
    /// A `DOMICILE_ADAPTIVE_SYNC_*` value.
    adaptive_sync: i32,
}

/// `DomicileHdrDisplay`, laid out as in the C header. 112 bytes, including 4
/// of tail padding.
#[derive(Clone, Copy, Debug)]
#[repr(C)]
struct RawHdrDisplay {
    adaptive: RawAdaptiveDisplay,
    /// A `DOMICILE_HDR_*` value.
    hdr: i32,
    /// In cd/m², zero where unreported.
    max_luminance: f32,
    max_average_luminance: f32,
    min_luminance: f32,
    sdr_white_nits: f32,
}

/// `DomicileHdrLayout`, laid out as in the C header. 80 bytes, no padding.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
struct RawHdrLayout {
    adaptive: RawAdaptiveLayout,
    /// Nonzero to ask for HDR10.
    hdr: i32,
    /// In cd/m².
    sdr_white_nits: f32,
}

/// `DomicileAdaptiveLayout`, laid out as in the C header. 72 bytes, including
/// 4 of tail padding.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
struct RawAdaptiveLayout {
    moded: RawModedLayout,
    /// Nonzero to ask for a variable refresh rate.
    adaptive_sync: i32,
}

/// `DomicileDisplayLayout`, laid out as in the C header. 48 bytes, no
/// padding.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
struct RawLayout {
    id: i64,
    /// Nonzero to light this connector.
    enabled: i32,
    x: i32,
    y: i32,
    /// `DomicileDisplayTransform`: the `wl_output` order, normal first.
    transform: u32,
    scale: f64,
    /// The display's place on the logical desktop. Zeros for a dark display.
    desk_x: i32,
    desk_y: i32,
    desk_width: i32,
    desk_height: i32,
}

/// `DomicileVirtualDisplay`, laid out as in the C header. 32 bytes, with four
/// of padding before `name`.
#[repr(C)]
struct RawVirtualDisplay {
    id: i64,
    width: i32,
    height: i32,
    refresh_mhz: i32,
    /// The name, borrowed for the call.
    name: *const c_char,
}

/// `DomicileDeskInput`, laid out as in the C header. 32 bytes, with four of
/// padding before `x`.
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
struct RawDeskInput {
    /// `DomicileDeskInputKind`: 0 pointer, 1 button, 2 scroll, 3 key.
    kind: u32,
    x: f64,
    y: f64,
    code: u32,
    pressed: u32,
}

impl From<DeskInput> for RawDeskInput {
    fn from(input: DeskInput) -> RawDeskInput {
        let (kind, x, y, code, pressed) = match input {
            DeskInput::Pointer { x, y } => (0, x, y, 0, false),
            DeskInput::Button { code, pressed } => (1, 0.0, 0.0, code, pressed),
            DeskInput::Scroll { dx, dy } => (2, dx, dy, 0, false),
            DeskInput::Key { code, pressed } => (3, 0.0, 0.0, code, pressed),
        };
        RawDeskInput {
            kind,
            x,
            y,
            code,
            pressed: u32::from(pressed),
        }
    }
}

/// `DomicilePointerTarget`, laid out as in the C header. 16 bytes, no padding.
#[repr(C)]
struct RawPointer {
    /// The device's name, borrowed for the call.
    device: *const c_char,
    display_id: i64,
}

/// `DomicileCapturedFrame`, laid out as in the C header. The fds are lent for
/// the callback.
#[derive(Clone, Copy)]
#[repr(C)]
struct RawCapturedFrame {
    /// `DomicileCaptureMemory`: 0 a dmabuf, 1 shared memory.
    memory: u32,
    width: u32,
    height: u32,
    fourcc: u32,
    modifier: u64,
    plane_count: u32,
    planes: [Plane; MAX_PLANES],
    content_x: i32,
    content_y: i32,
    content_width: i32,
    content_height: i32,
    damage_x: i32,
    damage_y: i32,
    damage_width: i32,
    damage_height: i32,
}

/// `DomicileSpikeCapture`, laid out as in the C header.
///
/// A struct rather than an array because Chromium's `-Wunsafe-buffer-usage`
/// forbids indexing a bare pointer.
#[derive(Default)]
#[repr(C)]
struct RawCapture {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    window_width: i32,
    window_height: i32,
}

/// Where a color is in the browser's window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Spike only. The result of searching the browser window for a color.
///
/// `window` is the captured bitmap's size, which may differ from the
/// requested size; reporting it exposes coordinate bugs. `bounds` is the
/// color's extent, or `None` if absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capture {
    pub window: (i32, i32),
    pub bounds: Option<Bounds>,
}

impl Engine {
    /// Loads the library and connects to the browser over `socket`.
    ///
    /// `library` is a name or a path, resolved as `dlopen` does.
    pub fn load(library: impl AsRef<Path>, socket: impl AsRef<Path>) -> Result<Self, EngineError> {
        let path = library.as_ref().to_path_buf();
        // SAFETY: loading runs the library's initializers, and there is no
        // safe way to `dlopen`.
        let library = unsafe { Library::new(&path) }.map_err(|source| EngineError::Library {
            path: path.clone(),
            source,
        })?;

        let events = Box::new(RefCell::new(Vec::new()));
        let handle = join(&library, &path, &events, socket.as_ref())?;

        Ok(Self {
            handle,
            events,
            library,
            path,
            said_it_cannot_crop: Cell::new(false),
            said_it_cannot_wait: Cell::new(false),
            said_it_cannot_turn: Cell::new(false),
        })
    }

    /// Connects to a replacement browser over the `socket` it bound.
    ///
    /// Reuses the loaded library: it initializes process-global mojo state
    /// once, and supports several connections in one process. The old
    /// connection is destroyed first, since two cannot share mojo core. Queued
    /// events are discarded because they name the old connection's surfaces.
    ///
    /// On failure the handle is null, which every ABI entry point ignores and
    /// [`Engine::fd`] reports as -1, so the caller can retry later.
    ///
    /// No automated check covers this; see
    /// `docs/HARDWARE-CHECKS.md#dead-engine-with-windows-open`.
    pub fn reconnect(&mut self, socket: &Path) -> Result<(), EngineError> {
        self.let_the_old_one_go();
        self.events.borrow_mut().clear();
        self.handle = join(&self.library, &self.path, &self.events, socket)?;
        Ok(())
    }

    /// Destroys the connection, if any. The handle is null after a failed
    /// reconnect.
    fn let_the_old_one_go(&mut self) {
        let handle = std::mem::replace(&mut self.handle, std::ptr::null_mut());
        if !handle.is_null() {
            if let Ok(f) = self.symbol::<unsafe extern "C" fn(*mut Handle)>(
                b"domicile_engine_destroy\0",
                "domicile_engine_destroy",
            ) {
                // SAFETY: the handle is live, and was replaced with null so
                // nothing uses it afterward.
                unsafe { f(handle) };
            }
        }
    }

    /// The fd to poll. Readable when [`Engine::dispatch`] has work.
    pub fn fd(&self) -> RawFd {
        let f: Symbol<unsafe extern "C" fn(*mut Handle) -> c_int> = self
            .symbol(b"domicile_engine_fd\0", "domicile_engine_fd")
            .expect("the library was checked at load");
        // SAFETY: the handle is live for the life of self.
        unsafe { f(self.handle) }
    }

    /// Runs pending work and returns the events the browser sent.
    pub fn dispatch(&self) -> Vec<Event> {
        let f: Symbol<unsafe extern "C" fn(*mut Handle)> = self
            .symbol(b"domicile_engine_dispatch\0", "domicile_engine_dispatch")
            .expect("the library was checked at load");
        // SAFETY: as above. The callbacks fire synchronously inside this call,
        // on this thread, and push into `events`.
        unsafe { f(self.handle) };
        self.events.borrow_mut().drain(..).collect()
    }

    /// Whether the engine calls `frame_done` and `presented`. An older one
    /// ignores them, so the compositor answers frame callbacks at commit.
    pub fn reports_frames(&self) -> bool {
        self.symbol::<unsafe extern "C" fn() -> c_int>(
            b"domicile_engine_reports_frames\0",
            "domicile_engine_reports_frames",
        )
        .is_ok()
    }

    /// Asks the browser to broker a frame sink for a new window.
    pub fn create_surface(&self, app_id: &str) -> Result<SurfaceId, EngineError> {
        let name = CString::new(app_id)?;
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const c_char) -> SurfaceId> =
            self.symbol(b"domicile_surface_create\0", "domicile_surface_create")?;
        // SAFETY: as above.
        let surface = unsafe { f(self.handle, name.as_ptr()) };
        if surface == 0 {
            return Err(EngineError::NoFrameSink {
                app_id: app_id.to_owned(),
            });
        }
        Ok(surface)
    }

    /// Destroys a window's surface and its frame sink.
    pub fn destroy_surface(&self, surface: SurfaceId) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId)> =
            match self.symbol(b"domicile_surface_destroy\0", "domicile_surface_destroy") {
                Ok(symbol) => symbol,
                Err(_) => return,
            };
        // SAFETY: as above.
        unsafe { f(self.handle, surface) };
    }

    /// Imports a client's dmabuf. `None` if the browser refused it, as it
    /// always does on an ozone platform without `CreateNativePixmapFromHandle`.
    ///
    /// The fds are borrowed; the caller keeps the client's `wl_buffer`.
    pub fn import(&self, surface: SurfaceId, dmabuf: &Dmabuf) -> Option<BufferId> {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId, *const Dmabuf) -> BufferId> =
            self.symbol(b"domicile_surface_import\0", "domicile_surface_import")
                .ok()?;
        // SAFETY: as above, and `dmabuf` outlives the call.
        let buffer = unsafe { f(self.handle, surface, dmabuf as *const Dmabuf) };
        (buffer != 0).then_some(buffer)
    }

    /// Imports a window in shared memory, while the caller waits. `None` if
    /// the browser refused it, as it does while it composites on the GPU, or
    /// if the engine is too old to take one.
    ///
    /// The fd is borrowed; the engine duplicates it before returning.
    pub fn import_shm(&self, surface: SurfaceId, buffer: &ShmBuffer) -> Option<BufferId> {
        let f = self.import_shm_symbol().ok()?;
        // SAFETY: as above, and `buffer` outlives the call.
        let id = unsafe { f(self.handle, surface, buffer as *const ShmBuffer) };
        (id != 0).then_some(id)
    }

    /// Whether the engine has [`Engine::import_shm`].
    pub fn imports_shm(&self) -> bool {
        self.import_shm_symbol().is_ok()
    }

    #[allow(clippy::type_complexity)] // the C signature, spelled out
    fn import_shm_symbol(
        &self,
    ) -> Result<
        Symbol<'_, unsafe extern "C" fn(*mut Handle, SurfaceId, *const ShmBuffer) -> BufferId>,
        EngineError,
    > {
        self.symbol(
            b"domicile_surface_import_shm\0",
            "domicile_surface_import_shm",
        )
    }

    /// Whether the engine has [`Engine::import_in_the_background`]. An older
    /// one has only [`Engine::import`], which blocks the caller.
    pub fn imports_in_the_background(&self) -> bool {
        self.import_async().is_ok()
    }

    /// Starts importing a client's dmabuf and returns at once. The answer
    /// arrives as an [`Event::Imported`] carrying `request`.
    ///
    /// The fds are borrowed; the engine duplicates them before returning.
    pub fn import_in_the_background(&self, surface: SurfaceId, dmabuf: &Dmabuf, request: Request) {
        let f = self
            .import_async()
            .expect("the caller checked imports_in_the_background");
        // SAFETY: as above, and `dmabuf` outlives the call.
        unsafe { f(self.handle, surface, dmabuf as *const Dmabuf, request) };
    }

    #[allow(clippy::type_complexity)] // the C signature, spelled out
    fn import_async(
        &self,
    ) -> Result<
        Symbol<'_, unsafe extern "C" fn(*mut Handle, SurfaceId, *const Dmabuf, Request)>,
        EngineError,
    > {
        self.symbol(
            b"domicile_surface_import_async\0",
            "domicile_surface_import_async",
        )
    }

    /// Tells the browser the contents of a clipboard.
    ///
    /// The compositor reads every new selection eagerly, so the browser can
    /// paste from memory. Send empty contents for an empty clipboard, or the
    /// browser keeps the old contents. The browser copies the bytes before
    /// returning.
    ///
    /// An engine without `domicile_clipboard_set_items` is told only the text.
    pub fn set_clipboard(&self, clipboard: Clipboard, contents: &Contents) {
        #[allow(clippy::type_complexity)] // the C signature, spelled out
        let items: Result<
            Symbol<unsafe extern "C" fn(*mut Handle, u32, *const RawClipboardItem, u32)>,
            _,
        > = self.symbol(
            b"domicile_clipboard_set_items\0",
            "domicile_clipboard_set_items",
        );
        match items {
            Ok(f) => {
                let items = Items::of(contents);
                // SAFETY: as above, and the records and what they point at
                // outlive the call because `items` and `contents` do.
                unsafe {
                    f(
                        self.handle,
                        clipboard.as_raw(),
                        items.raw().as_ptr(),
                        items.raw().len() as u32,
                    );
                };
            }
            Err(_) => {
                self.set_clipboard_text(clipboard, contents.text.as_deref().unwrap_or_default())
            }
        }
    }

    /// Tells an engine that predates `domicile_clipboard_set_items` the text
    /// on a clipboard. Passed with a length because copied text may contain a
    /// nul.
    fn set_clipboard_text(&self, clipboard: Clipboard, text: &str) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, u32, *const c_char, usize)> =
            match self.symbol(b"domicile_clipboard_set\0", "domicile_clipboard_set") {
                Ok(symbol) => symbol,
                Err(_) => return,
            };
        // SAFETY: as above, and the slice outlives the call because `text`
        // does.
        unsafe {
            f(
                self.handle,
                clipboard.as_raw(),
                text.as_ptr().cast::<c_char>(),
                text.len(),
            );
        };
    }

    /// Whether the engine has `domicile_surface_sync`. An older one shows
    /// each submit at once, so the compositor cannot sync a move with it.
    pub fn syncs_frames(&self) -> bool {
        self.surface_sync().is_ok()
    }

    /// Makes `surface`'s next submit, and each after it, go up at synced
    /// `frame`. Only for an engine that [`Engine::syncs_frames`], with a
    /// `frame` above the last. See
    /// `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
    pub fn sync(&self, surface: SurfaceId, frame: u32) {
        let f = self
            .surface_sync()
            .expect("the caller checked syncs_frames");
        // SAFETY: the handle is live for the life of self.
        unsafe { f(self.handle, surface, frame) };
    }

    /// Sets `surface`'s subsurfaces, bottom to top, which its frames draw
    /// with it from its next frame (`domicile_surface_set_children`). Each
    /// is placed in logical pixels from the top left of `surface`'s crop.
    ///
    /// A subsurface takes frames once the engine embeds it, which it reports
    /// as [`Event::Configure`]; submit to it at [`NEWEST_BOX`].
    pub fn set_children(&self, surface: SurfaceId, children: &[Subsurface]) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId, *const Subsurface, u32)> =
            match self.symbol(
                b"domicile_surface_set_children\0",
                "domicile_surface_set_children",
            ) {
                Ok(symbol) => symbol,
                Err(err) => {
                    tracing::error!(%err, "subsurfaces cannot be drawn in their windows");
                    return;
                }
            };
        let count = u32::try_from(children.len()).expect("a surface has few subsurfaces");
        // SAFETY: the handle is live for the life of self; `children` is
        // borrowed for the call.
        unsafe { f(self.handle, surface, children.as_ptr(), count) };
    }

    /// Sends `surface`'s last frame again, to show subsurfaces set since with
    /// no new buffer of its own (`domicile_surface_redraw`). The frame
    /// answers no [`Event::FrameDone`] or [`Event::Presented`].
    pub fn redraw(&self, surface: SurfaceId) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId)> =
            match self.symbol(b"domicile_surface_redraw\0", "domicile_surface_redraw") {
                Ok(symbol) => symbol,
                Err(err) => {
                    tracing::error!(%err, "subsurfaces cannot be drawn in their windows");
                    return;
                }
            };
        // SAFETY: the handle is live for the life of self.
        unsafe { f(self.handle, surface) };
    }

    fn surface_sync(
        &self,
    ) -> Result<Symbol<'_, unsafe extern "C" fn(*mut Handle, SurfaceId, u32)>, EngineError> {
        self.symbol(b"domicile_surface_sync\0", "domicile_surface_sync")
    }

    /// Whether the engine has `domicile_surface_submit_fenced`. An older one
    /// reads a buffer as soon as it is submitted, so the compositor must wait
    /// for its own draw into one first.
    pub fn takes_fences(&self) -> bool {
        self.submit_fenced().is_ok()
    }

    /// Submits a frame showing the `sampled` part of `buffer`
    /// (`wl_surface.commit`), turned upright, at the newest box numbered at
    /// most `at_box` (see [`Event::Configure`]).
    ///
    /// The crop is the window geometry, which excludes client-drawn shadows
    /// (see [`crate::window_geometry`]). An empty crop means the whole buffer;
    /// empty damage means the whole surface.
    ///
    /// With `fence`, viz reads the buffer only once the fence signals. Only
    /// for an engine that [`Engine::takes_fences`]. The fd is borrowed.
    pub fn submit(
        &self,
        surface: SurfaceId,
        buffer: BufferId,
        sampled: Sampled,
        damage: (i32, i32, i32, i32),
        at_box: u64,
        fence: Option<BorrowedFd<'_>>,
    ) {
        match fence {
            Some(fence) => self.submit_after(surface, buffer, sampled, damage, at_box, fence),
            None => self.submit_now(surface, buffer, sampled, damage, at_box),
        }
    }

    /// Submits with an acquire fence.
    fn submit_after(
        &self,
        surface: SurfaceId,
        buffer: BufferId,
        sampled: Sampled,
        damage: (i32, i32, i32, i32),
        at_box: u64,
        fence: BorrowedFd<'_>,
    ) {
        let f = self
            .submit_fenced()
            .expect("the caller checked takes_fences");
        let (crop_x, crop_y, crop_width, crop_height) = sampled.crop;
        let (x, y, width, height) = damage;
        // SAFETY: as above, and `fence` outlives the call; the engine
        // duplicates it.
        unsafe {
            f(
                self.handle,
                surface,
                buffer,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
                x,
                y,
                width,
                height,
                at_box,
                abi_transform(sampled.transform),
                fence.as_raw_fd(),
            )
        };
    }

    #[allow(clippy::type_complexity)] // the C signature, spelled out
    fn submit_fenced(
        &self,
    ) -> Result<
        Symbol<
            '_,
            unsafe extern "C" fn(
                *mut Handle,
                SurfaceId,
                BufferId,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                u64,
                u32,
                c_int,
            ),
        >,
        EngineError,
    > {
        self.symbol(
            b"domicile_surface_submit_fenced\0",
            "domicile_surface_submit_fenced",
        )
    }

    /// Submits a buffer the compositor has finished drawing into.
    fn submit_now(
        &self,
        surface: SurfaceId,
        buffer: BufferId,
        sampled: Sampled,
        damage: (i32, i32, i32, i32),
        at_box: u64,
    ) {
        #[allow(clippy::type_complexity)] // the C signature, spelled out
        let f: Symbol<
            unsafe extern "C" fn(
                *mut Handle,
                SurfaceId,
                BufferId,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                u64,
                u32,
            ),
        > = match self.symbol(
            b"domicile_surface_submit_transformed\0",
            "domicile_surface_submit_transformed",
        ) {
            Ok(symbol) => symbol,
            // An older engine shows every buffer as drawn, so a client that
            // turned its buffer for a rotated monitor is shown turned.
            Err(why) => {
                if sampled.transform != BufferTransform::Normal
                    && !self.said_it_cannot_turn.replace(true)
                {
                    tracing::error!(%why, "windows drawn turned are shown turned");
                }
                return self.submit_unturned(surface, buffer, sampled.crop, damage, at_box);
            }
        };
        let (crop_x, crop_y, crop_width, crop_height) = sampled.crop;
        let (x, y, width, height) = damage;
        // SAFETY: as above.
        unsafe {
            f(
                self.handle,
                surface,
                buffer,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
                x,
                y,
                width,
                height,
                at_box,
                abi_transform(sampled.transform),
            )
        };
    }

    /// Submits without a transform, for an engine without
    /// `domicile_surface_submit_transformed`.
    fn submit_unturned(
        &self,
        surface: SurfaceId,
        buffer: BufferId,
        crop: (i32, i32, i32, i32),
        damage: (i32, i32, i32, i32),
        at_box: u64,
    ) {
        #[allow(clippy::type_complexity)] // the C signature, spelled out
        let f: Symbol<
            unsafe extern "C" fn(
                *mut Handle,
                SurfaceId,
                BufferId,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                u64,
            ),
        > = match self.symbol(
            b"domicile_surface_submit_for_box\0",
            "domicile_surface_submit_for_box",
        ) {
            Ok(symbol) => symbol,
            // An older engine shows every frame at the newest box, so a
            // resized window's old frame is stretched until it redraws. The
            // damage was mapped onto another box, so the whole box is
            // damaged.
            Err(why) => {
                if !self.said_it_cannot_wait.replace(true) {
                    tracing::error!(%why, "resized windows stretch until they redraw");
                }
                return self.submit_at_the_newest_box(surface, buffer, crop, (0, 0, 0, 0));
            }
        };
        let (crop_x, crop_y, crop_width, crop_height) = crop;
        let (x, y, width, height) = damage;
        // SAFETY: as above.
        unsafe {
            f(
                self.handle,
                surface,
                buffer,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
                x,
                y,
                width,
                height,
                at_box,
            )
        };
    }

    /// Submits at the newest box, for an engine without
    /// `domicile_surface_submit_for_box`.
    fn submit_at_the_newest_box(
        &self,
        surface: SurfaceId,
        buffer: BufferId,
        crop: (i32, i32, i32, i32),
        damage: (i32, i32, i32, i32),
    ) {
        #[allow(clippy::type_complexity)] // the C signature, spelled out
        let f: Symbol<
            unsafe extern "C" fn(
                *mut Handle,
                SurfaceId,
                BufferId,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
                i32,
            ),
        > = match self.symbol(
            b"domicile_surface_submit_crop\0",
            "domicile_surface_submit_crop",
        ) {
            Ok(symbol) => symbol,
            // An older engine without cropping: draw the whole buffer,
            // shadow included.
            Err(why) => {
                if !self.said_it_cannot_crop.replace(true) {
                    tracing::error!(%why, "windows are drawn uncropped, shadows and all");
                }
                return self.submit_uncropped(surface, buffer, damage);
            }
        };
        let (crop_x, crop_y, crop_width, crop_height) = crop;
        let (x, y, width, height) = damage;
        // SAFETY: as above.
        unsafe {
            f(
                self.handle,
                surface,
                buffer,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
                x,
                y,
                width,
                height,
            )
        };
    }

    /// Submits the whole buffer, for an engine without
    /// `domicile_surface_submit_crop`.
    fn submit_uncropped(&self, surface: SurfaceId, buffer: BufferId, damage: (i32, i32, i32, i32)) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId, BufferId, i32, i32, i32, i32)> =
            match self.symbol(b"domicile_surface_submit\0", "domicile_surface_submit") {
                Ok(symbol) => symbol,
                Err(_) => return,
            };
        let (x, y, width, height) = damage;
        // SAFETY: as above.
        unsafe { f(self.handle, surface, buffer, x, y, width, height) };
    }

    /// Tells the browser which connectors to light and where.
    ///
    /// An empty list means no profile: the engine lights what the hardware
    /// reports, undoing any earlier profile. The result arrives later as an
    /// [`Event::Displays`].
    ///
    /// An engine without `domicile_displays_configure_modes` gets the layout
    /// without its modes, and lights each connector at its native one.
    pub fn configure_displays(&self, connectors: &[Connector]) {
        type Hdr = unsafe extern "C" fn(*mut Handle, *const RawHdrLayout, u32);
        if let Ok(f) = self.symbol::<Hdr>(
            b"domicile_displays_configure_hdr\0",
            "domicile_displays_configure_hdr",
        ) {
            let raw = hdr_layouts_from(connectors);
            // SAFETY: as above, and `raw` outlives the call; the engine
            // copies it.
            unsafe { f(self.handle, raw.as_ptr(), raw.len() as u32) };
            return;
        }
        type Adaptive = unsafe extern "C" fn(*mut Handle, *const RawAdaptiveLayout, u32);
        if let Ok(f) = self.symbol::<Adaptive>(
            b"domicile_displays_configure_adaptive\0",
            "domicile_displays_configure_adaptive",
        ) {
            let raw = adaptive_layouts_from(connectors);
            // SAFETY: as above, and `raw` outlives the call; the engine
            // copies it.
            unsafe { f(self.handle, raw.as_ptr(), raw.len() as u32) };
            return;
        }
        type Moded = unsafe extern "C" fn(*mut Handle, *const RawModedLayout, u32);
        if let Ok(f) = self.symbol::<Moded>(
            b"domicile_displays_configure_modes\0",
            "domicile_displays_configure_modes",
        ) {
            let raw = moded_layouts_from(connectors);
            // SAFETY: as above, and `raw` outlives the call; the engine
            // copies it.
            unsafe { f(self.handle, raw.as_ptr(), raw.len() as u32) };
            return;
        }
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const RawLayout, u32)> = match self.symbol(
            b"domicile_displays_configure\0",
            "domicile_displays_configure",
        ) {
            Ok(symbol) => symbol,
            Err(_) => return,
        };
        let raw = layouts_from(connectors);
        // SAFETY: as above, and `raw` outlives the call; the engine copies it.
        unsafe { f(self.handle, raw.as_ptr(), raw.len() as u32) };
    }

    /// Tells the browser which monitors with no connector to add, replacing the
    /// last list.
    ///
    /// Each joins the next [`Event::Displays`], to be laid out with
    /// [`Engine::configure_displays`] like a connector. Off a tty the engine
    /// ignores it.
    pub fn configure_virtual_displays(&self, displays: &[VirtualDisplay]) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const RawVirtualDisplay, u32)> = match self
            .symbol(
                b"domicile_virtual_displays_configure\0",
                "domicile_virtual_displays_configure",
            ) {
            Ok(symbol) => symbol,
            Err(_) => return,
        };
        let names: Vec<CString> = displays
            .iter()
            .map(|display| {
                CString::new(display.name.as_str()).expect("a display's name has no NUL")
            })
            .collect();
        let raw: Vec<RawVirtualDisplay> = displays
            .iter()
            .zip(&names)
            .map(|(display, name)| RawVirtualDisplay {
                id: display.id,
                width: logical(display.mode.0),
                height: logical(display.mode.1),
                refresh_mhz: i32::try_from(display.refresh_mhz)
                    .expect("a refresh rate fits an int32_t"),
                name: name.as_ptr(),
            })
            .collect();
        // SAFETY: as above; `raw` and `names` outlive the call, and the engine
        // copies both.
        unsafe { f(self.handle, raw.as_ptr(), raw.len() as u32) };
    }

    /// Applies touchpad and relative mouse settings, replacing the previous ones.
    pub fn configure_input(&self, input: &domicile_config::InputConfig) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const c_char)> = self
            .symbol(b"domicile_input_configure\0", "domicile_input_configure")
            .expect("the library was checked at load");
        let settings = serde_json::json!({
            "touchpad": input.touchpad,
            "mouse": input.mouse,
            "keyboard": {
                "repeat_delay_ms": input.keyboard.repeat.delay_ms,
                "repeat_rate": input.keyboard.repeat.rate,
            },
        });
        let settings = CString::new(settings.to_string()).expect("JSON escapes NUL bytes");
        // SAFETY: the handle is live and the engine copies the JSON before returning.
        unsafe { f(self.handle, settings.as_ptr()) };
    }

    /// Tells the browser which display each tablet or touchscreen covers.
    ///
    /// The list replaces the last one. A device it does not name covers no
    /// display.
    pub fn configure_pointers(&self, pointers: &[Pointer]) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const RawPointer, u32)> = match self
            .symbol(
                b"domicile_pointers_configure\0",
                "domicile_pointers_configure",
            ) {
            Ok(symbol) => symbol,
            Err(_) => return,
        };
        let devices: Vec<CString> = pointers
            .iter()
            .map(|pointer| {
                CString::new(pointer.device.as_str())
                    .expect("input.pointers refuses a device with a nul")
            })
            .collect();
        let raw: Vec<RawPointer> = devices
            .iter()
            .zip(pointers)
            .map(|(device, pointer)| RawPointer {
                device: device.as_ptr(),
                display_id: pointer.display,
            })
            .collect();
        // SAFETY: as above, and `devices` and `raw` outlive the call; the
        // engine copies them.
        unsafe { f(self.handle, raw.as_ptr(), raw.len() as u32) };
    }

    /// Sets the gamma ramp display `display` draws with: red, then green,
    /// then blue, each a third of `ramp`, as `wlr-gamma-control` lays them
    /// out. An empty ramp draws colors as they are. Nested, the engine ignores
    /// it: the host session draws the monitors.
    pub fn set_gamma(&self, display: i64, ramp: &[u16]) {
        assert_eq!(ramp.len() % 3, 0, "a gamma ramp has three equal channels");
        let f: Symbol<unsafe extern "C" fn(*mut Handle, i64, *const u16, u32)> = match self.symbol(
            b"domicile_displays_set_gamma\0",
            "domicile_displays_set_gamma",
        ) {
            Ok(symbol) => symbol,
            Err(_) => return,
        };
        // SAFETY: as above, and `ramp` holds three channels of the size passed
        // and outlives the call; the engine copies it.
        unsafe { f(self.handle, display, ramp.as_ptr(), (ramp.len() / 3) as u32) };
    }

    /// Sets the 3x3 color matrix, row-major, display `display` draws with in
    /// linear light: a night light on a display driven in HDR. An engine
    /// older than `domicile_displays_set_color_matrix` ignores it.
    pub fn set_color_matrix(&self, display: i64, matrix: &[f32; 9]) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, i64, *const f32)> = match self.symbol(
            b"domicile_displays_set_color_matrix\0",
            "domicile_displays_set_color_matrix",
        ) {
            Ok(symbol) => symbol,
            Err(_) => return,
        };
        // SAFETY: as above, and `matrix` holds the nine numbers the engine
        // reads and outlives the call; the engine copies them.
        unsafe { f(self.handle, display, matrix.as_ptr()) };
    }

    /// Hands one emulated event to the shell's window, on a headless desk.
    /// Returns false for an engine older than `domicile_input_inject`.
    pub fn inject_input(&self, input: DeskInput) -> bool {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const RawDeskInput)> =
            match self.symbol(b"domicile_input_inject\0", "domicile_input_inject") {
                Ok(symbol) => symbol,
                Err(_) => return false,
            };
        let raw = RawDeskInput::from(input);
        // SAFETY: as above, and `raw` outlives the call; the engine copies it.
        unsafe { f(self.handle, &raw) };
        true
    }

    /// Sets how `surface`'s pixels encode color; `None` is sRGB. Buffers
    /// imported afterward are drawn in it, so import a buffer again to show it
    /// in the new color. An engine without `domicile_surface_set_color` draws
    /// every buffer as sRGB.
    pub fn set_surface_color(&self, surface: SurfaceId, color: Option<&Color>) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId, *const Color)> = match self
            .symbol(
                b"domicile_surface_set_color\0",
                "domicile_surface_set_color",
            ) {
            Ok(symbol) => symbol,
            Err(_) => return,
        };
        let color = color.map_or(std::ptr::null(), |color| color as *const Color);
        // SAFETY: as above, and `color` outlives the call.
        unsafe { f(self.handle, surface, color) };
    }

    /// Releases an imported buffer after the client destroys its `wl_buffer`.
    pub fn forget(&self, surface: SurfaceId, buffer: BufferId) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, SurfaceId, BufferId)> =
            match self.symbol(b"domicile_buffer_destroy\0", "domicile_buffer_destroy") {
                Ok(symbol) => symbol,
                Err(_) => return,
            };
        // SAFETY: as above.
        unsafe { f(self.handle, surface, buffer) };
    }

    /// Captures what display `display` shows, `size` big, at most `max_fps`
    /// frames a second, for a screen cast. Frames arrive as
    /// [`Event::Captured`].
    ///
    /// `display` is a [`Display::id`]; zero names a nested engine's only
    /// window. An engine older than display capture has no symbol for it.
    pub fn start_capture(
        &self,
        display: i64,
        size: (u32, u32),
        max_fps: u32,
    ) -> Result<CaptureId, EngineError> {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, i64, u32, u32, u32) -> CaptureId> = self
            .symbol(
                b"domicile_display_capture_start\0",
                "domicile_display_capture_start",
            )?;
        // SAFETY: the handle is live for the life of self.
        let capture = unsafe { f(self.handle, display, size.0, size.1, max_fps) };
        match capture {
            0 => Err(EngineError::NoCapture { display }),
            capture => Ok(capture),
        }
    }

    /// Captures what browser window `window` shows, alone, at its own size,
    /// at most `max_fps` frames a second, for a screenshot. Frames arrive as
    /// [`Event::Captured`]; resize, stop and release it as a display capture.
    ///
    /// `window` is the id the shell's browser window list gives. An engine
    /// older than browser window capture has no symbol for it.
    pub fn start_browser_window_capture(
        &self,
        window: &str,
        max_fps: u32,
    ) -> Result<CaptureId, EngineError> {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *const c_char, u32) -> CaptureId> = self
            .symbol(
                b"domicile_browser_window_capture_start\0",
                "domicile_browser_window_capture_start",
            )?;
        let no_capture = || EngineError::NoBrowserWindowCapture {
            window: window.into(),
        };
        // No window's id holds a nul.
        let id = CString::new(window).map_err(|_| no_capture())?;
        // SAFETY: the handle is live for the life of self, and `id` outlives
        // the call; the engine copies it.
        match unsafe { f(self.handle, id.as_ptr(), max_fps) } {
            0 => Err(no_capture()),
            capture => Ok(capture),
        }
    }

    /// Captures at `size` from the next frame on.
    pub fn resize_capture(&self, capture: CaptureId, size: (u32, u32)) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, CaptureId, u32, u32)> = self
            .symbol(
                b"domicile_display_capture_resize\0",
                "domicile_display_capture_resize",
            )
            .expect("an engine that started a capture can resize it");
        // SAFETY: as above.
        unsafe { f(self.handle, capture, size.0, size.1) };
    }

    /// Stops a capture and releases every frame of it still held.
    pub fn stop_capture(&self, capture: CaptureId) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, CaptureId)> = self
            .symbol(
                b"domicile_display_capture_stop\0",
                "domicile_display_capture_stop",
            )
            .expect("an engine that started a capture can stop it");
        // SAFETY: as above.
        unsafe { f(self.handle, capture) };
    }

    /// Gives a captured frame's buffer back to the engine.
    pub fn release_captured(&self, capture: CaptureId, frame: u64) {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, CaptureId, u64)> = self
            .symbol(
                b"domicile_captured_frame_release\0",
                "domicile_captured_frame_release",
            )
            .expect("an engine that sent a frame can take it back");
        // SAFETY: as above.
        unsafe { f(self.handle, capture, frame) };
    }

    /// Spike only. The ARGB pixel at the center of the browser's window,
    /// where spike pages put the `<app>`.
    ///
    /// Lives here because only the compositor holds the browser's invitation.
    pub fn spike_window_center(&self) -> Option<u32> {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, *mut u32) -> bool> = self
            .symbol(
                b"domicile_engine_spike_sample_window_center\0",
                "domicile_engine_spike_sample_window_center",
            )
            .ok()?;
        let mut argb = 0u32;
        // SAFETY: the handle is live, and `argb` outlives the call.
        unsafe { f(self.handle, &mut argb) }.then_some(argb)
    }

    /// Spike only. The ARGB pixel at `x`, `y` in the browser's window, for
    /// pages with more than one `<app>`.
    pub fn spike_pixel(&self, x: i32, y: i32) -> Option<u32> {
        // A missing symbol means a stale library build; log it, because it
        // would otherwise look like a point outside the window.
        let f: Symbol<unsafe extern "C" fn(*mut Handle, i32, i32, *mut u32) -> bool> = match self
            .symbol(
                b"domicile_engine_spike_sample_pixel\0",
                "domicile_engine_spike_sample_pixel",
            ) {
            Ok(symbol) => symbol,
            Err(err) => {
                tracing::error!(
                    %err,
                    "libdomicile_engine.so has no \
                     domicile_engine_spike_sample_pixel; it was built before the probe \
                     grew a coordinate. Rebuild it: autoninja -C out/Domicile \
                     domicile_engine"
                );
                return None;
            }
        };
        let mut argb = 0u32;
        // SAFETY: the handle is live, and `argb` outlives the call.
        unsafe { f(self.handle, x, y, &mut argb) }.then_some(argb)
    }

    /// Spike only. Where `argb` is in the browser's window, and the window's
    /// size.
    ///
    /// `None` means nothing could be read, which differs from the color being
    /// absent (`bounds: None`); negative-control checks rely on the
    /// difference.
    pub fn spike_find(&self, argb: u32) -> Option<Capture> {
        let f: Symbol<unsafe extern "C" fn(*mut Handle, u32, *mut RawCapture) -> i32> = match self
            .symbol(
                b"domicile_engine_spike_find_color\0",
                "domicile_engine_spike_find_color",
            ) {
            Ok(symbol) => symbol,
            Err(err) => {
                tracing::error!(
                    %err,
                    "libdomicile_engine.so has no domicile_engine_spike_find_color; it was \
                     built before the shell guard existed. Rebuild it: autoninja -C \
                     out/Domicile domicile_engine"
                );
                return None;
            }
        };
        // Zeroed because the library writes only the size on status 0, and
        // the box too on status 1.
        let mut out = RawCapture::default();
        // SAFETY: the handle is live, and `out` is a `DomicileSpikeCapture`
        // that outlives the call.
        let status = unsafe { f(self.handle, argb, &mut out) };
        let window = (out.window_width, out.window_height);
        match status {
            0 => Some(Capture {
                window,
                bounds: None,
            }),
            1 => Some(Capture {
                window,
                bounds: Some(Bounds {
                    height: out.height,
                    width: out.width,
                    x: out.x,
                    y: out.y,
                }),
            }),
            _ => None,
        }
    }

    fn symbol<T>(&self, name: &[u8], readable: &'static str) -> Result<Symbol<'_, T>, EngineError> {
        symbol(&self.library, &self.path, name, readable)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.let_the_old_one_go();
    }
}

/// Connects to the browser at `socket`; callbacks push into `events`.
///
/// A free function because [`Engine::load`] calls it before an `Engine`
/// exists.
fn join(
    library: &Library,
    path: &Path,
    events: &RefCell<Vec<Event>>,
    socket: &Path,
) -> Result<*mut Handle, EngineError> {
    let callbacks = Callbacks {
        user_data: (events as *const RefCell<Vec<Event>>) as *mut c_void,
        configure: Some(on_configure),
        released: Some(on_released),
        displays: Some(on_displays),
        copied: Some(on_copied),
        configure_at: Some(on_configure_at),
        captured: Some(on_captured),
        capture_ended: Some(on_capture_ended),
        configure_box: Some(on_configure_box),
        copied_items: Some(on_copied_items),
        frame_done: Some(on_frame_done),
        presented: Some(on_presented),
        imported: Some(on_imported),
        connected_displays: Some(on_connected_displays),
        disconnected: Some(on_disconnected),
        compositing: Some(on_compositing),
        ramped_displays: Some(on_ramped_displays),
        moded_displays: Some(on_moded_displays),
        browser_windows: Some(on_browser_windows),
        adaptive_displays: Some(on_adaptive_displays),
        configure_zoomed: Some(on_configure_zoomed),
        hdr_displays: Some(on_hdr_displays),
        listed_browser_windows: Some(on_listed_browser_windows),
        input_devices: Some(on_input_devices),
        capture_failed: Some(on_capture_failed),
        viewed_browser_windows: Some(on_viewed_browser_windows),
    };
    let socket_c = CString::new(socket.as_os_str().as_encoded_bytes())?;
    let connect: Symbol<unsafe extern "C" fn(*const c_char, Callbacks) -> *mut Handle> = symbol(
        library,
        path,
        b"domicile_engine_connect\0",
        "domicile_engine_connect",
    )?;
    let _: Symbol<unsafe extern "C" fn(*mut Handle, *const c_char)> = symbol(
        library,
        path,
        b"domicile_input_configure\0",
        "domicile_input_configure",
    )?;
    // SAFETY: the signature matches domicile_engine.h, the string is
    // nul-terminated, and `events` outlives the handle because the same
    // `Engine` owns both.
    let handle = unsafe { connect(socket_c.as_ptr(), callbacks) };
    match handle.is_null() {
        true => Err(EngineError::Connect {
            socket: socket.to_path_buf(),
        }),
        false => Ok(handle),
    }
}

fn symbol<'library, T>(
    library: &'library Library,
    path: &Path,
    name: &[u8],
    readable: &'static str,
) -> Result<Symbol<'library, T>, EngineError> {
    // SAFETY: every caller states a signature that matches domicile_engine.h.
    unsafe { library.get(name) }.map_err(|source| EngineError::Symbol {
        path: path.to_path_buf(),
        symbol: readable,
        source,
    })
}

/// The callbacks only queue events; they fire inside `dispatch`.
extern "C" fn on_configure(user_data: *mut c_void, surface: SurfaceId, width: u32, height: u32) {
    push(
        user_data,
        Event::Configure {
            surface,
            width,
            height,
            scale: None,
            number: None,
            zoom: 1.0,
        },
    );
}

extern "C" fn on_configure_at(
    user_data: *mut c_void,
    surface: SurfaceId,
    width: u32,
    height: u32,
    scale: f64,
) {
    push(
        user_data,
        Event::Configure {
            surface,
            width,
            height,
            scale: Some(scale),
            number: None,
            zoom: 1.0,
        },
    );
}

extern "C" fn on_configure_box(
    user_data: *mut c_void,
    surface: SurfaceId,
    width: u32,
    height: u32,
    scale: f64,
    number: u64,
) {
    push(
        user_data,
        Event::Configure {
            surface,
            width,
            height,
            scale: Some(scale),
            number: Some(number),
            zoom: 1.0,
        },
    );
}

extern "C" fn on_configure_zoomed(
    user_data: *mut c_void,
    surface: SurfaceId,
    width: u32,
    height: u32,
    scale: f64,
    zoom: f64,
    number: u64,
) {
    push(
        user_data,
        Event::Configure {
            surface,
            width,
            height,
            scale: Some(scale),
            number: Some(number),
            zoom,
        },
    );
}

extern "C" fn on_imported(
    user_data: *mut c_void,
    surface: SurfaceId,
    request: Request,
    buffer: BufferId,
) {
    push(
        user_data,
        Event::Imported {
            surface,
            request,
            buffer: (buffer != 0).then_some(buffer),
        },
    );
}

extern "C" fn on_released(user_data: *mut c_void, surface: SurfaceId, buffer: BufferId) {
    push(user_data, Event::Released { surface, buffer });
}

/// Queues the display list, from an engine that reports no connectors.
///
/// An empty list is queued, not dropped: the engine never sends one, so
/// `Screens::from_the_engine` reports it as an error.
extern "C" fn on_displays(user_data: *mut c_void, displays: *const RawDisplay, count: u32) {
    // SAFETY: the ABI says `displays` points at `count` records, valid for
    // this call. `displays_from` copies them.
    let records = unsafe { std::slice::from_raw_parts(displays, count as usize) };
    push(user_data, Event::Displays(displays_from(records)));
}

/// Queues the display list with each display's connector. Called instead of
/// [`on_displays`] by an engine that reports connectors.
extern "C" fn on_connected_displays(
    user_data: *mut c_void,
    displays: *const RawConnectedDisplay,
    count: u32,
) {
    // SAFETY: the ABI says `displays` points at `count` records, valid for
    // this call. `connected_displays_from` copies them.
    let records = unsafe { std::slice::from_raw_parts(displays, count as usize) };
    push(user_data, Event::Displays(connected_displays_from(records)));
}

/// Queues a copy made in the browser, from an engine that predates
/// `copied_items`.
///
/// The text has a length rather than a nul terminator, because copied text
/// may contain a nul.
extern "C" fn on_copied(
    user_data: *mut c_void,
    clipboard: u32,
    text: *const c_char,
    length: usize,
) {
    assert!(
        !text.is_null(),
        "the engine sends the bytes that were copied, even if it sends none"
    );
    // SAFETY: the ABI says `text` points at `length` bytes, valid for this
    // call. `String::from_utf8_lossy` copies them.
    let bytes = unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length) };
    // Mojo already validates the text as UTF-8; lossy conversion avoids a
    // panic if that ever changes.
    let text = String::from_utf8_lossy(bytes).into_owned();
    push(
        user_data,
        Event::Copied {
            clipboard: clipboard_from(clipboard),
            contents: Contents {
                text: (!text.is_empty()).then_some(text),
                image: None,
            },
        },
    );
}

/// Queues a copy made in the browser: each type it can be pasted as.
extern "C" fn on_copied_items(
    user_data: *mut c_void,
    clipboard: u32,
    items: *const RawClipboardItem,
    count: u32,
) {
    let records = if count == 0 {
        &[][..]
    } else {
        // SAFETY: the ABI says `items` points at `count` records, valid for
        // this call. `contents_from` copies them.
        unsafe { std::slice::from_raw_parts(items, count as usize) }
    };
    push(
        user_data,
        Event::Copied {
            clipboard: clipboard_from(clipboard),
            contents: contents_from(records),
        },
    );
}

/// Copies a captured frame out of its record, duplicating the lent fds.
///
/// Panics on a memory kind the C header does not declare, rather than read
/// the planes wrongly.
fn captured_from(record: &RawCapturedFrame) -> Result<CapturedFrame, String> {
    let lent = &record.planes[..(record.plane_count as usize).min(MAX_PLANES)];
    let own = |plane: &Plane| {
        // SAFETY: the ABI lends each plane's fd for the callback this runs in.
        let fd = unsafe { BorrowedFd::borrow_raw(plane.fd) };
        fd.try_clone_to_owned()
            .map(|fd| SharedFd(Arc::new(fd)))
            .map_err(|why| format!("a captured frame's fd would not duplicate: {why}"))
    };
    let pixels = match record.memory {
        0 => CapturedPixels::Dmabuf {
            modifier: record.modifier,
            planes: lent
                .iter()
                .map(|plane| {
                    Ok(CapturedPlane {
                        fd: own(plane)?,
                        offset: plane.offset,
                        stride: plane.stride,
                    })
                })
                .collect::<Result<_, String>>()?,
        },
        1 => {
            let plane = lent
                .first()
                .ok_or("a shared memory frame came with no plane")?;
            CapturedPixels::Shm {
                fd: own(plane)?,
                stride: plane.stride,
            }
        }
        memory => {
            panic!("the engine sent a frame in memory the C header does not declare: {memory}")
        }
    };
    let damage = (
        record.damage_x,
        record.damage_y,
        record.damage_width,
        record.damage_height,
    );
    Ok(CapturedFrame {
        pixels,
        size: (record.width, record.height),
        fourcc: record.fourcc,
        content: (
            record.content_x,
            record.content_y,
            record.content_width,
            record.content_height,
        ),
        damage: (damage.2 > 0 && damage.3 > 0).then_some(damage),
    })
}

/// Queues a captured frame, with fds of its own.
extern "C" fn on_captured(
    user_data: *mut c_void,
    capture: CaptureId,
    frame: u64,
    record: *const RawCapturedFrame,
) {
    // SAFETY: the ABI lends a valid record for this call.
    let record = unsafe { &*record };
    push(
        user_data,
        Event::Captured {
            capture,
            frame,
            captured: captured_from(record),
        },
    );
}

extern "C" fn on_capture_ended(user_data: *mut c_void, capture: CaptureId) {
    push(user_data, Event::CaptureEnded { capture, why: None });
}

extern "C" fn on_capture_failed(user_data: *mut c_void, capture: CaptureId, why: *const c_char) {
    // SAFETY: the engine passes a NUL-terminated string, borrowed for the
    // call.
    let why = unsafe { std::ffi::CStr::from_ptr(why) }
        .to_string_lossy()
        .into_owned();
    push(
        user_data,
        Event::CaptureEnded {
            capture,
            why: Some(why),
        },
    );
}

extern "C" fn on_disconnected(user_data: *mut c_void) {
    push(user_data, Event::Disconnected);
}

extern "C" fn on_compositing(user_data: *mut c_void, in_memory: c_int) {
    push(
        user_data,
        Event::Compositing {
            in_memory: in_memory != 0,
        },
    );
}

extern "C" fn on_browser_windows(
    user_data: *mut c_void,
    windows: *const RawBrowserWindow,
    count: u32,
) {
    let records = if count == 0 {
        &[][..]
    } else {
        // SAFETY: the ABI says `windows` points at `count` records, valid for
        // this call. `browser_windows_from` copies them.
        unsafe { std::slice::from_raw_parts(windows, count as usize) }
    };
    push(
        user_data,
        Event::BrowserWindows(browser_windows_from(records)),
    );
}

/// As [`on_browser_windows`], with each window's address and whether it is
/// private. Called instead of it by an engine that reports them.
extern "C" fn on_listed_browser_windows(
    user_data: *mut c_void,
    windows: *const RawListedBrowserWindow,
    count: u32,
) {
    let records = if count == 0 {
        &[][..]
    } else {
        // SAFETY: as for `on_browser_windows`.
        unsafe { std::slice::from_raw_parts(windows, count as usize) }
    };
    push(
        user_data,
        Event::BrowserWindows(listed_browser_windows_from(records)),
    );
}

/// As [`on_listed_browser_windows`], with the views each window holds.
/// Called instead of it by an engine that reports them.
extern "C" fn on_viewed_browser_windows(
    user_data: *mut c_void,
    windows: *const RawListedBrowserWindow,
    count: u32,
    views: *const RawBrowserWindowView,
    view_count: u32,
) {
    let records = if count == 0 {
        &[][..]
    } else {
        // SAFETY: as for `on_browser_windows`.
        unsafe { std::slice::from_raw_parts(windows, count as usize) }
    };
    let views = if view_count == 0 {
        &[][..]
    } else {
        // SAFETY: as for `windows`.
        unsafe { std::slice::from_raw_parts(views, view_count as usize) }
    };
    let mut listed = listed_browser_windows_from(records);
    for view in views {
        let window = listed
            .get_mut(view.window as usize)
            .unwrap_or_else(|| panic!("the engine placed a view in window {}", view.window));
        window.views.push(BrowserView {
            // SAFETY: the ABI's strings are non-null and valid for the call.
            id: unsafe { copied(view.id) },
            x: view.x,
            y: view.y,
            width: view.width,
            height: view.height,
        });
    }
    push(user_data, Event::BrowserWindows(listed));
}

/// Copies the browser windows out of their records.
fn browser_windows_from(records: &[RawBrowserWindow]) -> Vec<BrowserWindow> {
    records
        .iter()
        .map(|record| BrowserWindow {
            // SAFETY: the ABI's strings are non-null and valid for the call.
            id: unsafe { copied(record.id) },
            // SAFETY: as for `id`.
            title: unsafe { copied(record.title) },
            // SAFETY: as for `id`.
            app_id: unsafe { copied(record.app_id) },
            // An older engine says neither.
            url: String::new(),
            private: false,
            views: Vec::new(),
        })
        .collect()
}

fn listed_browser_windows_from(records: &[RawListedBrowserWindow]) -> Vec<BrowserWindow> {
    records
        .iter()
        .map(|record| BrowserWindow {
            // SAFETY: the ABI's strings are non-null and valid for the call.
            id: unsafe { copied(record.id) },
            // SAFETY: as for `id`.
            title: unsafe { copied(record.title) },
            // SAFETY: as for `id`.
            app_id: unsafe { copied(record.app_id) },
            // SAFETY: as for `id`.
            url: unsafe { copied(record.url) },
            private: record.off_the_record != 0,
            views: Vec::new(),
        })
        .collect()
}

extern "C" fn on_input_devices(user_data: *mut c_void, devices: *const RawInputDevice, count: u32) {
    let records = if count == 0 {
        &[][..]
    } else {
        // SAFETY: the ABI says `devices` points at `count` records, valid for
        // this call. `inputs_from` copies them.
        unsafe { std::slice::from_raw_parts(devices, count as usize) }
    };
    push(user_data, Event::InputDevices(inputs_from(records)));
}

/// Copies the input devices out of their records.
fn inputs_from(records: &[RawInputDevice]) -> Vec<ListedInput> {
    records
        .iter()
        .map(|record| ListedInput {
            id: record.id,
            // SAFETY: the ABI's strings are non-null and valid for the call.
            name: unsafe { copied(record.name) },
            kind: input_kind(record.kind),
            connection: input_connection(record.connection),
            // SAFETY: as for `name`.
            sys_path: unsafe { copied(record.sys_path) },
            vendor: record.vendor_id,
            product: record.product_id,
        })
        .collect()
}

/// A `DomicileInputDeviceKind`. A kind this compositor does not know is from a
/// newer engine, and listed as other rather than dropped.
fn input_kind(kind: u8) -> InputKind {
    match kind {
        0 => InputKind::Keyboard,
        1 => InputKind::Mouse,
        2 => InputKind::Touchpad,
        3 => InputKind::Touchscreen,
        4 => InputKind::PointingStick,
        5 => InputKind::Tablet,
        6 => InputKind::Other,
        unknown => {
            tracing::error!(
                kind = unknown,
                "the engine listed an input device of an unknown kind"
            );
            InputKind::Other
        }
    }
}

/// A `DomicileInputDeviceConnection`, as [`input_kind`] reads a kind.
fn input_connection(connection: u8) -> InputConnection {
    match connection {
        0 => InputConnection::Unknown,
        1 => InputConnection::Internal,
        2 => InputConnection::Usb,
        3 => InputConnection::Bluetooth,
        unknown => {
            tracing::error!(
                connection = unknown,
                "the engine listed an input device on an unknown connection"
            );
            InputConnection::Unknown
        }
    }
}

extern "C" fn on_frame_done(user_data: *mut c_void, surface: SurfaceId, frame: u64) {
    push(user_data, Event::FrameDone { surface, frame });
}

extern "C" fn on_presented(
    user_data: *mut c_void,
    surface: SurfaceId,
    frame: u64,
    time_ns: i64,
    refresh_ns: i64,
    flags: u32,
) {
    push(
        user_data,
        Event::Presented {
            surface,
            frame,
            shown: shown_from(time_ns, refresh_ns, flags),
        },
    );
}

/// A `presented` callback's arguments. Panics on a negative time, which
/// `CLOCK_MONOTONIC` never gives.
fn shown_from(time_ns: i64, refresh_ns: i64, flags: u32) -> Option<Shown> {
    let nanos = |ns: i64| {
        Duration::from_nanos(u64::try_from(ns).expect("the engine reports no time before boot"))
    };
    (flags & PRESENTED_DISCARDED == 0).then(|| Shown {
        time: nanos(time_ns),
        refresh: (refresh_ns != 0).then(|| nanos(refresh_ns)),
        kind: flags,
    })
}

/// Converts the ABI's display records, from an engine that reports no
/// connectors.
fn displays_from(records: &[RawDisplay]) -> Vec<Display> {
    records.iter().map(display_from).collect()
}

/// Converts one display record, with no connector.
fn display_from(record: &RawDisplay) -> Display {
    Display {
        id: record.id,
        description: description_of(record),
        connector: String::new(),
        position: (record.x, record.y),
        size: (as_extent(record.width), as_extent(record.height)),
        physical_mm: (record.physical_width_mm, record.physical_height_mm),
        refresh_mhz: record.refresh_mhz,
        modes: Vec::new(),
        adaptive_sync: AdaptiveSync::Unsupported,
        hdr: Hdr::default(),
    }
}

/// Converts the ABI's connected display records.
fn connected_displays_from(records: &[RawConnectedDisplay]) -> Vec<Display> {
    records
        .iter()
        .map(|record| {
            assert!(
                !record.connector.is_null(),
                "the engine names every display's connector"
            );
            Display {
                // SAFETY: non-null per the assertion; the ABI guarantees a
                // nul-terminated string valid for this callback.
                connector: unsafe { copied(record.connector) },
                ..display_from(&record.display)
            }
        })
        .collect()
}

/// Queues each display's gamma ramp size, then the display list. Called
/// instead of [`on_connected_displays`] by an engine that reports ramp sizes.
extern "C" fn on_ramped_displays(
    user_data: *mut c_void,
    displays: *const RawRampedDisplay,
    count: u32,
) {
    // SAFETY: the ABI says `displays` points at `count` records, valid for
    // this call. Both conversions copy them.
    let records = unsafe { std::slice::from_raw_parts(displays, count as usize) };
    push(user_data, Event::GammaSizes(gamma_sizes_from(records)));
    let connected: Vec<RawConnectedDisplay> =
        records.iter().map(|record| record.connected).collect();
    push(
        user_data,
        Event::Displays(connected_displays_from(&connected)),
    );
}

/// Queues each display's gamma ramp size, then the display list with each
/// display's modes. Called instead of [`on_ramped_displays`] by an engine that
/// reports modes.
extern "C" fn on_moded_displays(
    user_data: *mut c_void,
    displays: *const RawModedDisplay,
    count: u32,
) {
    // SAFETY: the ABI says `displays` points at `count` records, valid for
    // this call. Both conversions copy them.
    let records = unsafe { std::slice::from_raw_parts(displays, count as usize) };
    let ramped: Vec<RawRampedDisplay> = records.iter().map(|record| record.ramped).collect();
    push(user_data, Event::GammaSizes(gamma_sizes_from(&ramped)));
    push(user_data, Event::Displays(moded_displays_from(records)));
}

/// Queues each display's gamma ramp size, then the display list with each
/// display's modes and adaptive sync. Called instead of [`on_moded_displays`]
/// by an engine that reports adaptive sync.
extern "C" fn on_adaptive_displays(
    user_data: *mut c_void,
    displays: *const RawAdaptiveDisplay,
    count: u32,
) {
    // SAFETY: the ABI says `displays` points at `count` records, valid for
    // this call. Both conversions copy them.
    let records = unsafe { std::slice::from_raw_parts(displays, count as usize) };
    let ramped: Vec<RawRampedDisplay> = records.iter().map(|record| record.moded.ramped).collect();
    push(user_data, Event::GammaSizes(gamma_sizes_from(&ramped)));
    push(user_data, Event::Displays(adaptive_displays_from(records)));
}

/// Converts the ABI's display records with their modes and adaptive sync.
fn adaptive_displays_from(records: &[RawAdaptiveDisplay]) -> Vec<Display> {
    let moded: Vec<RawModedDisplay> = records.iter().map(|record| record.moded).collect();
    moded_displays_from(&moded)
        .into_iter()
        .zip(records)
        .map(|(display, record)| Display {
            adaptive_sync: adaptive_sync_from(record.adaptive_sync),
            ..display
        })
        .collect()
}

/// Queues each display's gamma ramp size, then the display list with each
/// display's modes, adaptive sync and HDR. Called instead of
/// [`on_adaptive_displays`] by an engine that reports HDR.
extern "C" fn on_hdr_displays(user_data: *mut c_void, displays: *const RawHdrDisplay, count: u32) {
    // SAFETY: the ABI says `displays` points at `count` records, valid for
    // this call. Both conversions copy them.
    let records = unsafe { std::slice::from_raw_parts(displays, count as usize) };
    let ramped: Vec<RawRampedDisplay> = records
        .iter()
        .map(|record| record.adaptive.moded.ramped)
        .collect();
    push(user_data, Event::GammaSizes(gamma_sizes_from(&ramped)));
    push(user_data, Event::Displays(hdr_displays_from(records)));
}

/// Converts the ABI's display records with their modes, adaptive sync and
/// HDR.
fn hdr_displays_from(records: &[RawHdrDisplay]) -> Vec<Display> {
    let adaptive: Vec<RawAdaptiveDisplay> = records.iter().map(|record| record.adaptive).collect();
    adaptive_displays_from(&adaptive)
        .into_iter()
        .zip(records)
        .map(|(display, record)| Display {
            hdr: Hdr {
                state: hdr_state_from(record.hdr),
                max_luminance: whole(record.max_luminance),
                max_average_luminance: whole(record.max_average_luminance),
                min_luminance: whole(record.min_luminance * 10_000.0),
                sdr_white: whole(record.sdr_white_nits),
            },
            ..display
        })
        .collect()
}

/// A `DOMICILE_HDR_*` value. One this compositor has no name for is
/// unsupported, the state that asks nothing of it.
fn hdr_state_from(raw: i32) -> HdrState {
    match raw {
        1 => HdrState::Off,
        2 => HdrState::On,
        _ => HdrState::Unsupported,
    }
}

/// A luminance rounded to a whole number. An EDID cannot state a negative or
/// unbounded one, so either is unreported: zero. `as` saturates the rest.
fn whole(luminance: f32) -> u32 {
    if luminance.is_finite() && luminance > 0.0 {
        luminance.round() as u32
    } else {
        0
    }
}

/// A `DOMICILE_ADAPTIVE_SYNC_*` value. One this compositor has no name for is
/// unsupported, the state that asks nothing of it.
fn adaptive_sync_from(raw: i32) -> AdaptiveSync {
    match raw {
        1 => AdaptiveSync::Off,
        2 => AdaptiveSync::On,
        _ => AdaptiveSync::Unsupported,
    }
}

/// Converts the ABI's display records with their modes.
fn moded_displays_from(records: &[RawModedDisplay]) -> Vec<Display> {
    let connected: Vec<RawConnectedDisplay> = records
        .iter()
        .map(|record| record.ramped.connected)
        .collect();
    connected_displays_from(&connected)
        .into_iter()
        .zip(records)
        .map(|(display, record)| Display {
            modes: modes_of(record),
            ..display
        })
        .collect()
}

/// Copies one record's modes, dropping any with no pixels.
fn modes_of(record: &RawModedDisplay) -> Vec<Mode> {
    if record.mode_count == 0 {
        return Vec::new();
    }
    assert!(
        !record.modes.is_null(),
        "the engine points at the modes it counts"
    );
    // SAFETY: non-null per the assertion; the ABI says `modes` points at
    // `mode_count` records, valid for this callback.
    let modes = unsafe { std::slice::from_raw_parts(record.modes, record.mode_count as usize) };
    modes
        .iter()
        .filter_map(|mode| {
            Some(Mode {
                size: (
                    u32::try_from(mode.width).ok().filter(|width| *width > 0)?,
                    u32::try_from(mode.height)
                        .ok()
                        .filter(|height| *height > 0)?,
                ),
                refresh_mhz: mode.refresh_mhz,
            })
        })
        .collect()
}

/// Each display's gamma ramp size, leaving out those with none.
fn gamma_sizes_from(records: &[RawRampedDisplay]) -> HashMap<i64, u32> {
    records
        .iter()
        .filter(|record| record.gamma_size > 0)
        .map(|record| (record.connected.display.id, record.gamma_size))
        .collect()
}

/// A buffer transform as the ABI's `DomicileBufferTransform`: the
/// `wl_output.transform` order.
fn abi_transform(transform: BufferTransform) -> u32 {
    match transform {
        BufferTransform::Normal => 0,
        BufferTransform::_90 => 1,
        BufferTransform::_180 => 2,
        BufferTransform::_270 => 3,
        BufferTransform::Flipped => 4,
        BufferTransform::Flipped90 => 5,
        BufferTransform::Flipped180 => 6,
        BufferTransform::Flipped270 => 7,
    }
}

/// Converts connectors to the ABI's layout records.
fn layouts_from(connectors: &[Connector]) -> Vec<RawLayout> {
    connectors
        .iter()
        .map(|connector| RawLayout {
            id: connector.id,
            enabled: i32::from(connector.enabled),
            x: connector.origin.0,
            y: connector.origin.1,
            transform: match connector.transform {
                Transform::Normal => 0,
                Transform::Rotate90 => 1,
                Transform::Rotate180 => 2,
                Transform::Rotate270 => 3,
            },
            scale: connector.scale,
            desk_x: connector.desk.map_or(0, |desk| desk.position.0),
            desk_y: connector.desk.map_or(0, |desk| desk.position.1),
            desk_width: connector.desk.map_or(0, |desk| logical(desk.size.0)),
            desk_height: connector.desk.map_or(0, |desk| logical(desk.size.1)),
        })
        .collect()
}

/// The ABI's layout records with each connector's mode and rate.
fn moded_layouts_from(connectors: &[Connector]) -> Vec<RawModedLayout> {
    layouts_from(connectors)
        .into_iter()
        .zip(connectors)
        .map(|(layout, connector)| RawModedLayout {
            layout,
            mode_width: connector.mode.map_or(0, |mode| logical(mode.0)),
            mode_height: connector.mode.map_or(0, |mode| logical(mode.1)),
            refresh_mhz: connector.refresh_mhz.map_or(0, |refresh| {
                i32::try_from(refresh).expect("the config bounds a refresh rate to an int32_t")
            }),
        })
        .collect()
}

/// The ABI's layout records with each connector's mode, rate and adaptive
/// sync.
fn adaptive_layouts_from(connectors: &[Connector]) -> Vec<RawAdaptiveLayout> {
    moded_layouts_from(connectors)
        .into_iter()
        .zip(connectors)
        .map(|(moded, connector)| RawAdaptiveLayout {
            moded,
            adaptive_sync: i32::from(connector.adaptive_sync),
        })
        .collect()
}

/// The ABI's layout records with each connector's mode, rate, adaptive sync
/// and HDR.
fn hdr_layouts_from(connectors: &[Connector]) -> Vec<RawHdrLayout> {
    adaptive_layouts_from(connectors)
        .into_iter()
        .zip(connectors)
        .map(|(adaptive, connector)| RawHdrLayout {
            adaptive,
            hdr: i32::from(connector.hdr),
            sdr_white_nits: connector.sdr_white as f32,
        })
        .collect()
}

/// A logical size as an `int32_t`. Profiles that do not fit are refused
/// earlier, so this cannot fail.
fn logical(size: u32) -> i32 {
    i32::try_from(size).expect("a laid-out desktop fits an int32_t")
}

/// Copies the panel's name out of the record.
///
/// Panics on null, which the C header forbids, instead of reading it.
fn description_of(record: &RawDisplay) -> String {
    assert!(
        !record.name.is_null(),
        "the engine names every display, even if it names it nothing"
    );
    // SAFETY: non-null per the assertion; the ABI guarantees a nul-terminated
    // string valid for this callback.
    unsafe { copied(record.name) }
}

/// Copies a string the engine lends for a callback. Lossy because the engine
/// already limits names to printable ASCII, and bad firmware should not crash
/// the desktop.
///
/// # Safety
///
/// `borrowed` is a non-null, nul-terminated string valid for this call.
unsafe fn copied(borrowed: *const c_char) -> String {
    // SAFETY: the caller's obligation.
    unsafe { std::ffi::CStr::from_ptr(borrowed) }
        .to_string_lossy()
        .into_owned()
}

/// A display extent from the ABI's `int32_t`. Panics if negative rather
/// than casting to a wrong size.
fn as_extent(measure: i32) -> u32 {
    u32::try_from(measure).expect("a display's mode is never negative")
}

fn push(user_data: *mut c_void, event: Event) {
    if user_data.is_null() {
        return;
    }
    // SAFETY: `user_data` is the `Engine`'s boxed queue, passed to
    // domicile_engine_connect. Callbacks fire only inside dispatch, so the box
    // is alive and not borrowed elsewhere.
    let events = unsafe { &*(user_data as *const RefCell<Vec<Event>>) };
    events.borrow_mut().push(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dmabuf_descriptor::DmabufPlane as BridgePlane;
    use std::os::fd::IntoRawFd as _;

    #[test]
    fn a_captured_frame_is_the_record_the_c_header_declares() {
        // 16 (four `uint32_t`) + 8 (modifier) + 4 (count) + 48 (four planes)
        // + 32 (content and damage) + 4 tail padding.
        assert_eq!(std::mem::size_of::<RawCapturedFrame>(), 112);
    }

    #[test]
    fn a_shm_buffer_is_the_five_fields_the_c_header_declares() {
        assert_eq!(std::mem::size_of::<ShmBuffer>(), 20);
        assert_eq!(std::mem::offset_of!(ShmBuffer, fourcc), 16);
    }

    #[test]
    fn a_subsurface_is_laid_out_as_the_engine_reads_it() {
        // `DomicileSubsurface`: a u32, padding, four doubles, a u8, padding.
        assert_eq!(std::mem::size_of::<Subsurface>(), 48);
        assert_eq!(std::mem::offset_of!(Subsurface, x), 8);
        assert_eq!(std::mem::offset_of!(Subsurface, above), 40);
    }

    #[test]
    fn a_color_is_the_record_the_c_header_declares() {
        // 2 enums + reference + has_mastering (16), four chromaticities (32),
        // then four floats (16).
        assert_eq!(std::mem::size_of::<Color>(), 64);
        assert_eq!(std::mem::offset_of!(Color, mastering_red), 16);
        assert_eq!(std::mem::offset_of!(Color, mastering_min_luminance), 48);
        assert_eq!(std::mem::offset_of!(Color, max_fall), 60);
    }

    #[test]
    fn the_callbacks_are_the_user_data_and_twenty_five_pointers_the_c_header_declares() {
        // `released` follows `configure`, and `viewed_browser_windows` is
        // last, as in the header.
        assert_eq!(std::mem::size_of::<Callbacks>(), 26 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, released), 2 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, copied_items), 9 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, frame_done), 10 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, presented), 11 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, imported), 12 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, connected_displays), 13 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, disconnected), 14 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, compositing), 15 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, ramped_displays), 16 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, moded_displays), 17 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, browser_windows), 18 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, adaptive_displays), 19 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, configure_zoomed), 20 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, hdr_displays), 21 * 8);
        assert_eq!(
            std::mem::offset_of!(Callbacks, listed_browser_windows),
            22 * 8
        );
        assert_eq!(std::mem::offset_of!(Callbacks, input_devices), 23 * 8);
        assert_eq!(std::mem::offset_of!(Callbacks, capture_failed), 24 * 8);
        assert_eq!(
            std::mem::offset_of!(Callbacks, viewed_browser_windows),
            25 * 8
        );
    }

    #[test]
    fn an_input_device_is_two_strings_and_its_numbers_as_in_the_c_header() {
        // 2 strings (16), id (4), vendor and product (4), kind and connection
        // (2), then tail padding to 8.
        assert_eq!(std::mem::size_of::<RawInputDevice>(), 32);
        assert_eq!(std::mem::offset_of!(RawInputDevice, sys_path), 8);
        assert_eq!(std::mem::offset_of!(RawInputDevice, id), 16);
        assert_eq!(std::mem::offset_of!(RawInputDevice, vendor_id), 20);
        assert_eq!(std::mem::offset_of!(RawInputDevice, product_id), 22);
        assert_eq!(std::mem::offset_of!(RawInputDevice, kind), 24);
        assert_eq!(std::mem::offset_of!(RawInputDevice, connection), 25);
    }

    #[test]
    fn a_failed_capture_carries_the_engines_cause() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;

        on_capture_failed(queue, 3, c"viz ran out".as_ptr());

        assert_eq!(
            events.into_inner(),
            vec![Event::CaptureEnded {
                capture: 3,
                why: Some("viz ran out".into())
            }]
        );
    }

    #[test]
    fn the_input_devices_are_copied_out_of_their_records() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        let records = [
            RawInputDevice {
                name: c"Logitech MX Master 3".as_ptr(),
                sys_path: c"/sys/devices/usb1/input/input9".as_ptr(),
                id: 9,
                vendor_id: 0x046d,
                product_id: 0x4082,
                kind: 1,
                connection: 3,
            },
            RawInputDevice {
                name: c"Power Button".as_ptr(),
                sys_path: c"".as_ptr(),
                id: 2,
                vendor_id: 0,
                product_id: 0,
                kind: 200,
                connection: 200,
            },
        ];
        on_input_devices(queue, records.as_ptr(), 2);
        on_input_devices(queue, std::ptr::null(), 0);

        assert_eq!(
            events.into_inner(),
            vec![
                Event::InputDevices(vec![
                    ListedInput {
                        id: 9,
                        name: "Logitech MX Master 3".into(),
                        kind: InputKind::Mouse,
                        connection: InputConnection::Bluetooth,
                        sys_path: "/sys/devices/usb1/input/input9".into(),
                        vendor: 0x046d,
                        product: 0x4082,
                    },
                    ListedInput {
                        id: 2,
                        name: "Power Button".into(),
                        kind: InputKind::Other,
                        connection: InputConnection::Unknown,
                        sys_path: String::new(),
                        vendor: 0,
                        product: 0,
                    },
                ]),
                Event::InputDevices(Vec::new()),
            ]
        );
    }

    #[test]
    fn an_hdr_display_is_an_adaptive_display_and_its_luminances() {
        // 88 (`DomicileAdaptiveDisplay`) + 4 + 4 * 4 + 4 tail padding.
        assert_eq!(std::mem::size_of::<RawHdrDisplay>(), 112);
        assert_eq!(std::mem::offset_of!(RawHdrDisplay, hdr), 88);
        assert_eq!(std::mem::offset_of!(RawHdrDisplay, sdr_white_nits), 104);
    }

    #[test]
    fn an_hdr_layout_is_an_adaptive_layout_a_flag_and_a_white() {
        // 72 (`DomicileAdaptiveLayout`) + 4 + 4.
        assert_eq!(std::mem::size_of::<RawHdrLayout>(), 80);
        assert_eq!(std::mem::offset_of!(RawHdrLayout, hdr), 72);
        assert_eq!(std::mem::offset_of!(RawHdrLayout, sdr_white_nits), 76);
    }

    #[test]
    fn a_display_says_whether_it_is_in_hdr_and_how_bright_it_gets() {
        let (panel, _name) = named(
            RawDisplay {
                id: 7,
                width: 3840,
                height: 2160,
                ..RawDisplay::default()
            },
            "",
        );
        let connector = std::ffi::CString::new("DP-1").expect("no nul in it");
        let record = |hdr, sdr_white_nits| RawHdrDisplay {
            adaptive: RawAdaptiveDisplay {
                moded: RawModedDisplay {
                    ramped: RawRampedDisplay {
                        connected: RawConnectedDisplay {
                            display: panel,
                            connector: connector.as_ptr(),
                        },
                        gamma_size: 0,
                    },
                    modes: std::ptr::null(),
                    mode_count: 0,
                },
                adaptive_sync: 0,
            },
            hdr,
            max_luminance: 599.6,
            max_average_luminance: 350.0,
            min_luminance: 0.05,
            sdr_white_nits,
        };
        let displays = hdr_displays_from(&[record(2, 240.0), record(1, 0.0), record(7, 0.0)]);
        assert_eq!(
            displays[0].hdr,
            Hdr {
                state: HdrState::On,
                max_luminance: 600,
                max_average_luminance: 350,
                min_luminance: 500,
                sdr_white: 240,
            }
        );
        assert_eq!(displays[1].hdr.state, HdrState::Off);
        assert_eq!(
            displays[2].hdr.state,
            HdrState::Unsupported,
            "a state from a newer engine asks nothing of this compositor"
        );
    }

    #[test]
    fn a_connector_asks_for_hdr_and_its_white_in_its_layout() {
        let asking = Connector {
            hdr: true,
            sdr_white: 240,
            ..LIT
        };
        let raw = hdr_layouts_from(&[asking, LIT]);
        assert_eq!((raw[0].hdr, raw[0].sdr_white_nits), (1, 240.0));
        assert_eq!(raw[1].hdr, 0);
        assert_eq!(raw[0].adaptive, adaptive_layouts_from(&[asking])[0]);
    }

    #[test]
    fn an_adaptive_display_is_a_moded_display_and_its_state() {
        // 80 (`DomicileModedDisplay`) + 4 + 4 tail padding.
        assert_eq!(std::mem::size_of::<RawAdaptiveDisplay>(), 88);
        assert_eq!(std::mem::offset_of!(RawAdaptiveDisplay, adaptive_sync), 80);
    }

    #[test]
    fn an_adaptive_layout_is_a_moded_layout_and_a_flag() {
        // 64 (`DomicileModedLayout`) + 4 + 4 tail padding.
        assert_eq!(std::mem::size_of::<RawAdaptiveLayout>(), 72);
        assert_eq!(std::mem::offset_of!(RawAdaptiveLayout, adaptive_sync), 64);
    }

    #[test]
    fn a_display_says_whether_it_scans_out_with_adaptive_sync() {
        let (panel, _name) = named(
            RawDisplay {
                id: 7,
                width: 2560,
                height: 1440,
                ..RawDisplay::default()
            },
            "",
        );
        let connector = std::ffi::CString::new("DP-1").expect("no nul in it");
        let record = |adaptive_sync| RawAdaptiveDisplay {
            moded: RawModedDisplay {
                ramped: RawRampedDisplay {
                    connected: RawConnectedDisplay {
                        display: panel,
                        connector: connector.as_ptr(),
                    },
                    gamma_size: 0,
                },
                modes: std::ptr::null(),
                mode_count: 0,
            },
            adaptive_sync,
        };
        let states: Vec<AdaptiveSync> = adaptive_displays_from(&[
            record(0),
            record(1),
            record(2),
            // A state from a newer engine asks nothing of this compositor.
            record(7),
        ])
        .iter()
        .map(|display| display.adaptive_sync)
        .collect();
        assert_eq!(
            states,
            vec![
                AdaptiveSync::Unsupported,
                AdaptiveSync::Off,
                AdaptiveSync::On,
                AdaptiveSync::Unsupported,
            ]
        );
    }

    #[test]
    fn a_connector_asks_for_adaptive_sync_in_its_layout() {
        let asking = Connector {
            adaptive_sync: true,
            ..LIT
        };
        let raw = adaptive_layouts_from(&[asking, LIT]);
        assert_eq!(raw[0].adaptive_sync, 1);
        assert_eq!(raw[1].adaptive_sync, 0);
        assert_eq!(raw[0].moded, moded_layouts_from(&[asking])[0]);
    }

    #[test]
    fn a_moded_display_is_a_ramped_display_and_its_modes() {
        // 64 (`DomicileRampedDisplay`) + 8 (pointer) + 4 (`mode_count`) + 4
        // tail padding. A mode is three `int32_t`.
        assert_eq!(std::mem::size_of::<RawMode>(), 12);
        assert_eq!(std::mem::size_of::<RawModedDisplay>(), 80);
        assert_eq!(std::mem::offset_of!(RawModedDisplay, modes), 64);
        assert_eq!(std::mem::offset_of!(RawModedDisplay, mode_count), 72);
    }

    #[test]
    fn a_moded_layout_is_a_layout_a_mode_and_a_rate() {
        // 48 (`DomicileDisplayLayout`) + 12 (three `int32_t`) + 4 tail
        // padding.
        assert_eq!(std::mem::size_of::<RawModedLayout>(), 64);
        assert_eq!(std::mem::offset_of!(RawModedLayout, mode_width), 48);
        assert_eq!(std::mem::offset_of!(RawModedLayout, refresh_mhz), 56);
    }

    #[test]
    fn a_display_carries_the_modes_its_monitor_offers() {
        let (panel, _name) = named(
            RawDisplay {
                id: 7,
                width: 1920,
                height: 1080,
                ..RawDisplay::default()
            },
            "",
        );
        let connector = std::ffi::CString::new("eDP-1").expect("no nul in it");
        let modes = [
            RawMode {
                width: 2880,
                height: 1920,
                refresh_mhz: 60_000,
            },
            RawMode {
                width: 1920,
                height: 1080,
                refresh_mhz: 120_000,
            },
            // A mode with no pixels is dropped rather than offered.
            RawMode::default(),
        ];
        let record = RawModedDisplay {
            ramped: RawRampedDisplay {
                connected: RawConnectedDisplay {
                    display: panel,
                    connector: connector.as_ptr(),
                },
                gamma_size: 0,
            },
            modes: modes.as_ptr(),
            mode_count: modes.len() as u32,
        };
        let displays = moded_displays_from(&[record]);
        assert_eq!(
            displays[0].size,
            (1920, 1080),
            "the size is the mode it is at"
        );
        assert_eq!(
            displays[0].modes,
            vec![
                Mode {
                    size: (2880, 1920),
                    refresh_mhz: 60_000
                },
                Mode {
                    size: (1920, 1080),
                    refresh_mhz: 120_000
                },
            ]
        );
        let none = RawModedDisplay {
            modes: std::ptr::null(),
            mode_count: 0,
            ..record
        };
        assert!(moded_displays_from(&[none])[0].modes.is_empty());
    }

    #[test]
    fn a_presented_frame_keeps_its_time_refresh_and_kind() {
        // DOMICILE_PRESENTED_VSYNC | DOMICILE_PRESENTED_HW_COMPLETION.
        assert_eq!(
            shown_from(1_500_000_000, 16_666_667, 0x1 | 0x4),
            Some(Shown {
                time: Duration::from_nanos(1_500_000_000),
                refresh: Some(Duration::from_nanos(16_666_667)),
                kind: 0x1 | 0x4,
            })
        );
        assert_eq!(
            shown_from(5, 0, 0).map(|shown| shown.refresh),
            Some(None),
            "zero is an unknown refresh"
        );
    }

    #[test]
    fn a_discarded_frame_was_not_shown() {
        assert_eq!(shown_from(0, 0, 0x8000_0000), None);
    }

    #[test]
    fn an_import_answers_its_request_with_the_buffer_or_a_refusal() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        on_imported(queue, 2, 5, 11);
        on_imported(queue, 2, 6, 0);

        assert_eq!(
            events.into_inner(),
            vec![
                Event::Imported {
                    surface: 2,
                    request: 5,
                    buffer: Some(11),
                },
                // Zero is never a buffer, so it is the refusal.
                Event::Imported {
                    surface: 2,
                    request: 6,
                    buffer: None,
                },
            ]
        );
    }

    #[test]
    fn a_browser_window_is_three_strings_as_in_the_c_header() {
        assert_eq!(std::mem::size_of::<RawBrowserWindow>(), 3 * 8);
        assert_eq!(std::mem::offset_of!(RawBrowserWindow, title), 8);
        assert_eq!(std::mem::offset_of!(RawBrowserWindow, app_id), 16);
    }

    #[test]
    fn a_listed_browser_window_is_four_strings_and_a_flag_as_in_the_c_header() {
        assert_eq!(std::mem::size_of::<RawListedBrowserWindow>(), 5 * 8);
        assert_eq!(std::mem::offset_of!(RawListedBrowserWindow, title), 8);
        assert_eq!(std::mem::offset_of!(RawListedBrowserWindow, app_id), 16);
        assert_eq!(std::mem::offset_of!(RawListedBrowserWindow, url), 24);
        assert_eq!(
            std::mem::offset_of!(RawListedBrowserWindow, off_the_record),
            32
        );
    }

    #[test]
    fn the_listed_browser_windows_are_copied_out_of_their_records() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        let records = [
            RawListedBrowserWindow {
                id: c"3".as_ptr(),
                title: c"Inbox".as_ptr(),
                app_id: c"mail".as_ptr(),
                url: c"https://mail.example/".as_ptr(),
                off_the_record: 1,
            },
            RawListedBrowserWindow {
                id: c"5".as_ptr(),
                title: c"".as_ptr(),
                app_id: c"".as_ptr(),
                url: c"about:blank".as_ptr(),
                off_the_record: 0,
            },
        ];
        on_listed_browser_windows(queue, records.as_ptr(), 2);
        on_listed_browser_windows(queue, std::ptr::null(), 0);

        assert_eq!(
            events.into_inner(),
            vec![
                Event::BrowserWindows(vec![
                    BrowserWindow {
                        id: "3".into(),
                        title: "Inbox".into(),
                        app_id: "mail".into(),
                        url: "https://mail.example/".into(),
                        private: true,
                        views: Vec::new(),
                    },
                    BrowserWindow {
                        id: "5".into(),
                        title: String::new(),
                        app_id: String::new(),
                        url: "about:blank".into(),
                        private: false,
                        views: Vec::new(),
                    },
                ]),
                Event::BrowserWindows(Vec::new()),
            ]
        );
    }

    #[test]
    fn an_older_engines_browser_windows_have_no_address_and_are_not_private() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        let records = [RawBrowserWindow {
            id: c"3".as_ptr(),
            title: c"Inbox".as_ptr(),
            app_id: c"mail".as_ptr(),
        }];
        on_browser_windows(queue, records.as_ptr(), 1);

        assert_eq!(
            events.into_inner(),
            vec![Event::BrowserWindows(vec![BrowserWindow {
                id: "3".into(),
                title: "Inbox".into(),
                app_id: "mail".into(),
                url: String::new(),
                private: false,
                views: Vec::new(),
            }])]
        );
    }

    #[test]
    fn a_browser_window_view_is_a_string_an_index_and_four_numbers_as_in_the_c_header() {
        assert_eq!(std::mem::size_of::<RawBrowserWindowView>(), 4 * 8);
        assert_eq!(std::mem::offset_of!(RawBrowserWindowView, window), 8);
        assert_eq!(std::mem::offset_of!(RawBrowserWindowView, x), 12);
        assert_eq!(std::mem::offset_of!(RawBrowserWindowView, height), 24);
    }

    #[test]
    fn each_view_is_copied_into_the_window_that_holds_it_bottom_first() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        let windows = [
            RawListedBrowserWindow {
                id: c"3".as_ptr(),
                title: c"Inbox".as_ptr(),
                app_id: c"".as_ptr(),
                url: c"https://mail.example/".as_ptr(),
                off_the_record: 0,
            },
            RawListedBrowserWindow {
                id: c"5".as_ptr(),
                title: c"Claude".as_ptr(),
                app_id: c"claude-desktop".as_ptr(),
                url: c"app://claude/".as_ptr(),
                off_the_record: 0,
            },
        ];
        let views = [
            RawBrowserWindowView {
                id: c"7".as_ptr(),
                window: 1,
                x: 0,
                y: 0,
                width: 200,
                height: 600,
            },
            RawBrowserWindowView {
                id: c"6".as_ptr(),
                window: 1,
                x: 0,
                y: 40,
                width: 800,
                height: 560,
            },
        ];
        on_viewed_browser_windows(queue, windows.as_ptr(), 2, views.as_ptr(), 2);

        let Event::BrowserWindows(listed) = &events.borrow()[0] else {
            panic!("no browser windows were listed");
        };
        assert_eq!(listed[0].views, []);
        assert_eq!(
            listed[1].views,
            [
                BrowserView {
                    id: "7".into(),
                    x: 0,
                    y: 0,
                    width: 200,
                    height: 600,
                },
                BrowserView {
                    id: "6".into(),
                    x: 0,
                    y: 40,
                    width: 800,
                    height: 560,
                },
            ]
        );
    }

    #[test]
    fn any_nonzero_compositing_is_in_memory() {
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        on_compositing(queue, 1);
        on_compositing(queue, 0);

        assert_eq!(
            events.into_inner(),
            vec![
                Event::Compositing { in_memory: true },
                Event::Compositing { in_memory: false },
            ]
        );
    }

    /// A pipe's read end, standing in for a buffer's fd.
    fn an_fd() -> RawFd {
        let (read, _write) = std::io::pipe().expect("a pipe");
        OwnedFd::from(read).into_raw_fd()
    }

    fn record(memory: u32, fds: &[RawFd]) -> RawCapturedFrame {
        let mut planes = [Plane {
            fd: -1,
            offset: 0,
            stride: 0,
        }; MAX_PLANES];
        for (index, (slot, &fd)) in planes.iter_mut().zip(fds).enumerate() {
            *slot = Plane {
                fd,
                offset: index as u32 * 4096,
                stride: 1600,
            };
        }
        RawCapturedFrame {
            memory,
            width: 400,
            height: 300,
            fourcc: FOURCCS[0],
            modifier: 7,
            plane_count: fds.len() as u32,
            planes,
            content_x: 0,
            content_y: 25,
            content_width: 400,
            content_height: 250,
            damage_x: 0,
            damage_y: 0,
            damage_width: 0,
            damage_height: 0,
        }
    }

    #[test]
    fn a_shared_memory_frame_crosses_as_its_own_fd_and_stride() {
        let lent = an_fd();

        let captured = captured_from(&record(1, &[lent])).expect("a frame");

        let CapturedPixels::Shm { fd, stride } = &captured.pixels else {
            panic!("a shared memory frame crossed as {:?}", captured.pixels);
        };
        // Its own: the engine closes the lent fd after the callback.
        assert_ne!(fd.0.as_raw_fd(), lent);
        assert_eq!(*stride, 1600);
        assert_eq!(captured.size, (400, 300));
        assert_eq!(captured.content, (0, 25, 400, 250));
        // Empty damage is all of it.
        assert_eq!(captured.damage, None);
    }

    #[test]
    fn a_dmabuf_frame_crosses_with_every_plane_and_its_damage() {
        let mut raw = record(0, &[an_fd(), an_fd()]);
        (
            raw.damage_x,
            raw.damage_y,
            raw.damage_width,
            raw.damage_height,
        ) = (1, 2, 3, 4);

        let captured = captured_from(&raw).expect("a frame");

        let CapturedPixels::Dmabuf { modifier, planes } = &captured.pixels else {
            panic!("a dmabuf frame crossed as {:?}", captured.pixels);
        };
        assert_eq!(*modifier, 7);
        assert_eq!(
            planes
                .iter()
                .map(|plane| (plane.offset, plane.stride))
                .collect::<Vec<_>>(),
            [(0, 1600), (4096, 1600)]
        );
        assert_eq!(captured.damage, Some((1, 2, 3, 4)));
    }

    #[test]
    #[should_panic(expected = "memory")]
    fn a_frame_in_memory_the_header_does_not_declare_is_refused() {
        let _ = captured_from(&record(2, &[an_fd()]));
    }

    /// The clipboard numbers are part of the ABI.
    #[test]
    fn each_clipboard_crosses_as_the_number_the_c_header_gives_it() {
        assert_eq!(Clipboard::Copy.as_raw(), 0);
        assert_eq!(Clipboard::Primary.as_raw(), 1);
        assert_eq!(clipboard_from(0), Clipboard::Copy);
        assert_eq!(clipboard_from(1), Clipboard::Primary);
    }

    /// `DomicileClipboardItem` is a pointer, a pointer and a `size_t`.
    #[test]
    fn a_clipboard_item_is_the_record_the_c_header_declares() {
        assert_eq!(std::mem::size_of::<RawClipboardItem>(), 24);
    }

    /// What the browser copied, as items, becomes the text and image it holds.
    #[test]
    fn copied_items_are_read_as_text_and_an_image() {
        let text = c"text/plain;charset=utf-8";
        let image = c"image/png";
        let items = [
            RawClipboardItem {
                mime_type: text.as_ptr(),
                data: b"words".as_ptr(),
                length: 5,
            },
            RawClipboardItem {
                mime_type: image.as_ptr(),
                data: [1u8, 2].as_ptr(),
                length: 2,
            },
        ];

        assert_eq!(
            contents_from(&items),
            Contents {
                text: Some("words".into()),
                image: Some(domicile_host::clipboard::Image::new(
                    "image/png",
                    vec![1, 2]
                )),
            }
        );
    }

    /// Contents cross as one item per part: the text once, as UTF-8, and the
    /// image under its own type. The browser offers the text under every
    /// text type itself.
    #[test]
    fn contents_cross_as_one_item_per_part() {
        let contents = Contents {
            text: Some("words".into()),
            image: Some(domicile_host::clipboard::Image::new("image/png", vec![3])),
        };

        let items = Items::of(&contents);

        assert_eq!(contents_from(items.raw()), contents);
        assert_eq!(items.raw().len(), 2);
    }

    /// Empty contents cross as no items, which clears the clipboard.
    #[test]
    fn empty_contents_cross_as_no_items() {
        assert!(Items::of(&Contents::default()).raw().is_empty());
    }

    /// An undeclared clipboard number panics rather than guessing.
    #[test]
    #[should_panic(expected = "clipboard")]
    fn a_clipboard_the_header_does_not_declare_is_refused() {
        clipboard_from(2);
    }

    /// Struct size checks mirror the C header's `static_assert`s. They catch
    /// added or dropped fields, not reorders.
    #[test]
    fn a_capture_is_the_six_int32_the_c_header_declares() {
        assert_eq!(
            std::mem::size_of::<RawCapture>(),
            6 * std::mem::size_of::<i32>()
        );
    }

    #[test]
    fn a_display_is_the_one_int64_the_pointer_and_seven_int32_the_c_header_declares() {
        // 8 (id) + 8 (name) + 28 (seven `int32_t`) + 4 tail padding. A
        // literal, because padding is part of the ABI.
        assert_eq!(std::mem::size_of::<RawDisplay>(), 48);
    }

    #[test]
    fn a_connected_display_is_a_display_and_a_pointer() {
        // 48 (`DomicileDisplay`) + 8 (connector). No padding.
        assert_eq!(std::mem::size_of::<RawConnectedDisplay>(), 56);
    }

    #[test]
    fn a_ramped_display_is_a_connected_display_and_a_uint32() {
        // 56 (`DomicileConnectedDisplay`) + 4 (`gamma_size`) + 4 tail padding.
        assert_eq!(std::mem::size_of::<RawRampedDisplay>(), 64);
        assert_eq!(std::mem::offset_of!(RawRampedDisplay, gamma_size), 56);
    }

    #[test]
    fn a_display_with_no_gamma_has_no_gamma_size() {
        let (laptop, _laptop_name) = named(
            RawDisplay {
                id: 7,
                ..RawDisplay::default()
            },
            "",
        );
        let (dock, _dock_name) = named(
            RawDisplay {
                id: 9,
                ..RawDisplay::default()
            },
            "",
        );
        let connector = std::ffi::CString::new("eDP-1").expect("no nul in it");
        let ramped = |display, gamma_size| RawRampedDisplay {
            connected: RawConnectedDisplay {
                display,
                connector: connector.as_ptr(),
            },
            gamma_size,
        };

        assert_eq!(
            gamma_sizes_from(&[ramped(laptop, 4096), ramped(dock, 0)]),
            HashMap::from([(7, 4096)])
        );
    }

    #[test]
    fn a_connector_is_the_int64_four_int32s_double_and_desk_the_c_header_declares() {
        // 8 (id) + 16 (three `int32_t`, one `uint32_t`) + 8 (`double`) + 16
        // (desk). No padding: the `double` is already aligned.
        assert_eq!(std::mem::size_of::<RawLayout>(), 48);
    }

    #[test]
    fn a_desk_input_is_the_record_the_c_header_declares() {
        // 4 (kind) + 4 padding + 16 (two `double`s) + 8 (code, pressed).
        assert_eq!(std::mem::size_of::<RawDeskInput>(), 32);
    }

    #[test]
    fn each_desk_input_has_the_kind_the_c_header_numbers() {
        assert_eq!(
            RawDeskInput::from(DeskInput::Pointer { x: 1.5, y: 2.0 }),
            RawDeskInput {
                kind: 0,
                x: 1.5,
                y: 2.0,
                code: 0,
                pressed: 0
            }
        );
        assert_eq!(
            RawDeskInput::from(DeskInput::Button {
                code: 0x110,
                pressed: true
            }),
            RawDeskInput {
                kind: 1,
                x: 0.0,
                y: 0.0,
                code: 0x110,
                pressed: 1
            }
        );
        assert_eq!(
            RawDeskInput::from(DeskInput::Scroll { dx: 0.0, dy: -15.0 }),
            RawDeskInput {
                kind: 2,
                x: 0.0,
                y: -15.0,
                code: 0,
                pressed: 0
            }
        );
        assert_eq!(
            RawDeskInput::from(DeskInput::Key {
                code: 30,
                pressed: false
            }),
            RawDeskInput {
                kind: 3,
                x: 0.0,
                y: 0.0,
                code: 30,
                pressed: 0
            }
        );
    }

    #[test]
    fn a_virtual_display_is_the_record_the_c_header_declares() {
        // 8 (id) + 3 * 4 (mode, rate) + 4 padding + 8 (name).
        assert_eq!(std::mem::size_of::<RawVirtualDisplay>(), 32);
    }

    #[test]
    fn a_virtual_display_is_told_from_a_connector_by_its_id() {
        let display = |id| Display {
            id,
            description: String::new(),
            connector: String::new(),
            position: (0, 0),
            size: (1920, 1080),
            physical_mm: (0, 0),
            refresh_mhz: 0,
            modes: Vec::new(),
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        };
        assert!(display(VirtualDisplay::id_of(1)).is_virtual());
        // EDID-derived ids are positive.
        assert!(!display(1).is_virtual());
    }

    #[test]
    fn a_pointer_target_is_the_pointer_and_int64_the_c_header_declares() {
        // 8 (device) + 8 (display id). No padding.
        assert_eq!(std::mem::size_of::<RawPointer>(), 16);
    }

    #[test]
    fn a_connector_crosses_with_the_turn_and_scale_its_window_is_drawn_at() {
        // `DomicileDisplayTransform` uses the `wl_output` order.
        let turned = |transform| layouts_from(&[Connector { transform, ..LIT }])[0].transform;
        assert_eq!(
            [
                turned(Transform::Normal),
                turned(Transform::Rotate90),
                turned(Transform::Rotate180),
                turned(Transform::Rotate270),
            ],
            [0, 1, 2, 3]
        );
        assert_eq!(layouts_from(&[LIT])[0].scale, 1.2);
    }

    #[test]
    fn a_buffer_transform_crosses_in_the_wl_output_order() {
        // `DomicileBufferTransform` uses the `wl_output.transform` order.
        assert_eq!(
            [
                BufferTransform::Normal,
                BufferTransform::_90,
                BufferTransform::_180,
                BufferTransform::_270,
                BufferTransform::Flipped,
                BufferTransform::Flipped90,
                BufferTransform::Flipped180,
                BufferTransform::Flipped270,
            ]
            .map(abi_transform),
            [0, 1, 2, 3, 4, 5, 6, 7]
        );
    }

    #[test]
    fn a_configure_carries_the_scale_of_the_page_that_laid_it_out() {
        // Only the engine knows the scale a box was laid out at.
        let events = RefCell::new(Vec::new());
        let queue = (&events as *const RefCell<Vec<Event>>) as *mut c_void;
        on_configure_zoomed(queue, 1, 640, 480, 2.0, 1.5, 8);
        on_configure_box(queue, 2, 640, 480, 2.0, 9);
        on_configure_at(queue, 3, 1200, 900, 1.5);
        on_configure(queue, 4, 800, 600);

        assert_eq!(
            events.into_inner(),
            vec![
                Event::Configure {
                    surface: 1,
                    width: 640,
                    height: 480,
                    scale: Some(2.0),
                    number: Some(8),
                    zoom: 1.5,
                },
                // An engine without `configure_zoomed` zooms nothing.
                Event::Configure {
                    surface: 2,
                    width: 640,
                    height: 480,
                    scale: Some(2.0),
                    number: Some(9),
                    zoom: 1.0,
                },
                // An engine without `configure_box` numbers no box.
                Event::Configure {
                    surface: 3,
                    width: 1200,
                    height: 900,
                    scale: Some(1.5),
                    number: None,
                    zoom: 1.0,
                },
                // An engine without `configure_at` sends no scale.
                Event::Configure {
                    surface: 4,
                    width: 800,
                    height: 600,
                    scale: None,
                    number: None,
                    zoom: 1.0,
                },
            ]
        );
    }

    /// A lit, scaled and rotated connector for tests to vary.
    const LIT: Connector = Connector {
        id: 7,
        enabled: true,
        origin: (3840, 0),
        transform: Transform::Rotate270,
        scale: 1.2,
        desk: Some(Desk {
            position: (1800, 0),
            size: (1800, 3200),
        }),
        mode: None,
        refresh_mhz: None,
        adaptive_sync: false,
        hdr: false,
        sdr_white: domicile_config::DEFAULT_SDR_WHITE,
    };

    #[test]
    fn a_lit_connector_crosses_as_its_corner_and_a_yes() {
        let raw = layouts_from(&[LIT]);

        assert_eq!(
            raw,
            vec![RawLayout {
                id: 7,
                enabled: 1,
                x: 3840,
                y: 0,
                transform: 3,
                scale: 1.2,
                desk_x: 1800,
                desk_y: 0,
                desk_width: 1800,
                desk_height: 3200,
            }]
        );
    }

    #[test]
    fn a_dark_connector_crosses_as_a_no_and_a_corner_that_still_matters() {
        // A dark connector still needs a position, or the engine places it
        // over a lit monitor.
        let raw = layouts_from(&[Connector {
            id: 3,
            enabled: false,
            origin: (11520, 0),
            transform: Transform::Normal,
            scale: 1.0,
            desk: None,
            mode: None,
            refresh_mhz: None,
            adaptive_sync: false,
            hdr: false,
            sdr_white: domicile_config::DEFAULT_SDR_WHITE,
        }]);

        assert_eq!(
            raw,
            vec![RawLayout {
                id: 3,
                enabled: 0,
                x: 11520,
                y: 0,
                transform: 0,
                scale: 1.0,
                // Not on the desk: zeros.
                desk_x: 0,
                desk_y: 0,
                desk_width: 0,
                desk_height: 0,
            }]
        );
    }

    /// `record` with its name set to `name`. Keep the returned `CString`
    /// alive while the record is used.
    fn named(record: RawDisplay, name: &str) -> (RawDisplay, std::ffi::CString) {
        let owned = std::ffi::CString::new(name).expect("a test name has no nul in it");
        (
            RawDisplay {
                name: owned.as_ptr(),
                ..record
            },
            owned,
        )
    }

    #[test]
    fn a_displays_name_crosses_as_the_panel_spelled_it() {
        let (record, _owned) = named(
            RawDisplay {
                id: 7,
                width: 2880,
                height: 1920,
                ..RawDisplay::default()
            },
            "DEL DELL U3219Q 2ZLS413",
        );

        assert_eq!(
            displays_from(&[record])[0].description,
            "DEL DELL U3219Q 2ZLS413"
        );
    }

    #[test]
    fn a_display_that_names_itself_nothing_crosses_as_nothing() {
        // E.g. a projector or virtual output. The id still identifies it.
        let (record, _owned) = named(RawDisplay::default(), "");

        assert_eq!(displays_from(&[record])[0].description, "");
    }

    #[test]
    #[should_panic(expected = "the engine names every display")]
    fn a_null_name_is_refused_rather_than_read() {
        // Reading a null pointer would be undefined behavior.
        let _ = displays_from(&[RawDisplay::default()]);
    }

    #[test]
    fn a_connected_display_crosses_with_its_connector() {
        let (display, _name) = named(
            RawDisplay {
                id: 9,
                width: 1920,
                height: 1080,
                ..RawDisplay::default()
            },
            "",
        );
        let connector = std::ffi::CString::new("HDMI-A-1").expect("no nul in it");

        assert_eq!(
            connected_displays_from(&[RawConnectedDisplay {
                display,
                connector: connector.as_ptr(),
            }]),
            vec![Display {
                id: 9,
                description: String::new(),
                connector: "HDMI-A-1".into(),
                position: (0, 0),
                size: (1920, 1080),
                physical_mm: (0, 0),
                refresh_mhz: 0,
                modes: Vec::new(),
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            }]
        );
    }

    #[test]
    #[should_panic(expected = "the engine names every display's connector")]
    fn a_null_connector_is_refused_rather_than_read() {
        let (display, _name) = named(RawDisplay::default(), "");

        let _ = connected_displays_from(&[RawConnectedDisplay {
            display,
            connector: std::ptr::null(),
        }]);
    }

    #[test]
    fn a_display_list_crosses_the_abi_as_the_compositor_counts_them() {
        // The projector reports no size or rate; zeros pass through as
        // zeros, which is what `wl_output` expects.
        let (panel, _panel_name) = named(
            RawDisplay {
                id: 7,
                x: 0,
                y: 0,
                width: 2880,
                height: 1920,
                physical_width_mm: 597,
                physical_height_mm: 336,
                refresh_mhz: 59_997,
                ..RawDisplay::default()
            },
            "BOE NE135A1M-NY1",
        );
        let (projector, _projector_name) = named(
            RawDisplay {
                id: 9,
                x: 2880,
                y: 0,
                width: 1920,
                height: 1080,
                physical_width_mm: 0,
                physical_height_mm: 0,
                refresh_mhz: 0,
                ..RawDisplay::default()
            },
            "",
        );
        assert_eq!(
            displays_from(&[panel, projector]),
            vec![
                Display {
                    id: 7,
                    description: "BOE NE135A1M-NY1".into(),
                    connector: String::new(),
                    position: (0, 0),
                    size: (2880, 1920),
                    physical_mm: (597, 336),
                    refresh_mhz: 59_997,
                    modes: Vec::new(),
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
                Display {
                    id: 9,
                    description: String::new(),
                    connector: String::new(),
                    position: (2880, 0),
                    size: (1920, 1080),
                    physical_mm: (0, 0),
                    refresh_mhz: 0,
                    modes: Vec::new(),
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
            ]
        );
    }

    fn descriptor(planes: usize) -> DmabufDescriptor {
        DmabufDescriptor {
            width: 320,
            height: 240,
            fourcc: 0x3432_4241,
            modifier: 0x0300_0000_0cdb_0140,
            planes: (0..planes)
                .map(|index| BridgePlane {
                    fd: 10 + index as i32,
                    offset: 4 * index as u32,
                    stride: 1280,
                })
                .collect(),
        }
    }

    #[test]
    fn a_single_plane_buffer_crosses_the_abi_intact() {
        let converted = Dmabuf::from_descriptor(&descriptor(1)).expect("one plane is describable");

        assert_eq!(converted.width, 320);
        assert_eq!(converted.height, 240);
        assert_eq!(converted.fourcc, 0x3432_4241);
        assert_eq!(converted.modifier, 0x0300_0000_0cdb_0140);
        assert_eq!(converted.plane_count, 1);
        assert_eq!(converted.planes[0].fd, 10);
        assert_eq!(converted.planes[0].stride, 1280);
    }

    #[test]
    fn every_plane_is_carried_in_order() {
        let converted = Dmabuf::from_descriptor(&descriptor(MAX_PLANES))
            .expect("four planes is the most the ABI takes");

        assert_eq!(converted.plane_count, MAX_PLANES as u32);
        for (index, plane) in converted.planes.iter().enumerate() {
            assert_eq!(plane.fd, 10 + index as i32, "plane {index}");
            assert_eq!(plane.offset, 4 * index as u32, "plane {index}");
        }
    }

    // Refused rather than truncated, which would draw a corrupt window.
    #[test]
    fn more_planes_than_the_abi_carries_are_refused() {
        assert!(Dmabuf::from_descriptor(&descriptor(MAX_PLANES + 1)).is_none());
    }

    #[test]
    fn a_buffer_with_no_planes_is_refused() {
        assert!(Dmabuf::from_descriptor(&descriptor(0)).is_none());
    }

    // Only the error paths can be tested without a Chromium build.

    #[test]
    fn a_missing_library_names_itself_and_how_to_build_it() {
        let error = Engine::load("libdomicile_engine_that_is_not_there.so", "/tmp/nowhere")
            .expect_err("a library that is not there cannot load");

        let message = error.to_string();
        assert!(
            matches!(error, EngineError::Library { .. }),
            "expected a load failure, got {error:?}"
        );
        assert!(
            message.contains("libdomicile_engine_that_is_not_there.so"),
            "the message has to name the library it looked for: {message}"
        );
        assert!(
            message.contains("build.sh"),
            "and say where it comes from, because not-built is the usual cause: {message}"
        );
    }

    // A wrong library gets a different error from a missing one.
    #[test]
    fn a_library_without_the_abi_says_it_is_the_wrong_one() {
        let error = Engine::load("libc.so.6", "/tmp/nowhere")
            .expect_err("libc has no domicile_engine_connect");

        let message = error.to_string();
        assert!(
            matches!(error, EngineError::Symbol { .. }),
            "expected a missing symbol, got {error:?}"
        );
        assert!(
            message.contains("domicile_engine_connect"),
            "the message has to name the symbol that was missing: {message}"
        );
    }

    #[test]
    fn a_path_with_a_nul_is_refused_rather_than_truncated() {
        let error = Engine::load("libc.so.6", "/tmp/no\0where")
            .expect_err("a nul byte cannot cross the ABI");

        assert!(
            matches!(error, EngineError::Path(_)),
            "expected the path to be refused, got {error:?}"
        );
    }
}
