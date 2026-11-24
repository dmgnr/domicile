//! A mapped toplevel that keeps drawing.
//!
//! It binds the usual desktop globals, completes the `xdg_surface` configure
//! handshake, attaches `wl_shm` buffers and redraws on every frame callback,
//! so checks can observe a live window.

use std::io::{Read as _, Write as _};
use std::os::fd::{AsFd as _, AsRawFd as _, BorrowedFd, OwnedFd};
use std::os::unix::fs::FileExt as _;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use wayland_client::backend::ObjectId;
use wayland_client::protocol::{
    wl_buffer, wl_callback, wl_compositor, wl_data_device, wl_data_device_manager, wl_data_offer,
    wl_data_source, wl_keyboard, wl_output, wl_pointer, wl_region, wl_registry, wl_seat, wl_shm,
    wl_shm_pool, wl_subcompositor, wl_subsurface, wl_surface, wl_touch,
};
use wayland_client::{
    delegate_noop, event_created_child, Connection, Dispatch, Proxy as _, QueueHandle, WEnum,
};
use wayland_protocols::wp::cursor_shape::v1::client::{
    wp_cursor_shape_device_v1, wp_cursor_shape_manager_v1,
};
use wayland_protocols::wp::fractional_scale::v1::client::{
    wp_fractional_scale_manager_v1, wp_fractional_scale_v1,
};
use wayland_protocols::wp::idle_inhibit::zv1::client::{
    zwp_idle_inhibit_manager_v1, zwp_idle_inhibitor_v1,
};
use wayland_protocols::wp::keyboard_shortcuts_inhibit::zv1::client::{
    zwp_keyboard_shortcuts_inhibit_manager_v1, zwp_keyboard_shortcuts_inhibitor_v1,
};
use wayland_protocols::wp::pointer_constraints::zv1::client::{
    zwp_confined_pointer_v1, zwp_locked_pointer_v1, zwp_pointer_constraints_v1,
};
use wayland_protocols::wp::pointer_gestures::zv1::client::{
    zwp_pointer_gesture_hold_v1, zwp_pointer_gesture_pinch_v1, zwp_pointer_gesture_swipe_v1,
    zwp_pointer_gestures_v1,
};
use wayland_protocols::wp::primary_selection::zv1::client::{
    zwp_primary_selection_device_manager_v1, zwp_primary_selection_device_v1,
    zwp_primary_selection_offer_v1, zwp_primary_selection_source_v1,
};
use wayland_protocols::wp::relative_pointer::zv1::client::{
    zwp_relative_pointer_manager_v1, zwp_relative_pointer_v1,
};
use wayland_protocols::wp::text_input::zv3::client::{
    zwp_text_input_manager_v3, zwp_text_input_v3,
};
use wayland_protocols::wp::viewporter::client::{wp_viewport, wp_viewporter};
use wayland_protocols::xdg::activation::v1::client::{xdg_activation_token_v1, xdg_activation_v1};
use wayland_protocols::xdg::decoration::zv1::client::{
    zxdg_decoration_manager_v1, zxdg_toplevel_decoration_v1,
};
use wayland_protocols::xdg::foreign::zv1::client::{zxdg_exported_v1, zxdg_exporter_v1};
use wayland_protocols::xdg::foreign::zv2::client::{zxdg_exported_v2, zxdg_exporter_v2};
use wayland_protocols::xdg::shell::client::{
    xdg_popup, xdg_positioner, xdg_surface, xdg_toplevel, xdg_wm_base,
};
use wayland_protocols::xdg::system_bell::v1::client::xdg_system_bell_v1;

use wayland_protocols_misc::server_decoration::client::{
    org_kde_kwin_server_decoration, org_kde_kwin_server_decoration_manager,
};

use crate::anchor_protocol::{domicile_anchor_manager_v1, domicile_toplevel_anchor_v1};
use crate::arguments::{
    Arguments, AskForFocus, AskTo, AskToDrag, ConstrainPointer, DeepFormat, HoldTheScreensOn,
    TakeTheShortcuts,
};

/// Why the client stopped.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("there is no compositor to connect to: {0}")]
    NoDisplay(String),

    #[error("the compositor advertises no {global}, which a window needs")]
    Missing { global: &'static str },

    #[error("the connection failed: {0}")]
    Lost(String),

    #[error("could not make a buffer to draw into: {0}")]
    NoBuffer(String),
}

/// The initial window size, in surface pixels.
///
/// Small, and not a screen size, so a full-screen window cannot hide a
/// placement bug. The client keeps this size unless
/// [`crate::arguments::Arguments::follow_configure`] is set.
const SIZE: (u32, u32) = (320, 240);

/// The `--popup` geometry as `(x, y, width, height)` in window surface
/// pixels. Public so checks can compare it with what the compositor reports.
pub const POPUP: (i32, i32, i32, i32) = (10, 20, 120, 80);

/// The `--repositioned-popup` geometry once it has moved, as [`POPUP`].
pub const POPUP_MOVED: (i32, i32, i32, i32) = (60, 50, 140, 90);

/// The `--bubble` geometry as `(x, y, width, height)` in window surface
/// pixels, when it opens.
pub const BUBBLE: (i32, i32, i32, i32) = (40, 30, 100, 60);

/// The `--bubble` geometry after its first frame. It grows and moves, as an
/// extension popup does once its page has laid out.
pub const BUBBLE_GROWN: (i32, i32, i32, i32) = (30, 25, 150, 90);

/// The `--scrolling-bubble` bubble as `(x, width, height)` in window surface
/// pixels. Its `y` is the stripe's, [`scrolled_to`] the frame.
pub const SCROLLING_BUBBLE: (i32, i32, i32) = (200, 80, 40);

/// The stripe a `--scrolling-bubble` window scrolls: the window's width, the
/// bubble's height. Public because `guard-scrolling-bubble.sh` finds it.
pub const STRIPE_COLOR: u32 = 0x00_33_99_66;

/// How far the stripe moves each frame, in surface pixels. More than a
/// captured frame's rounding, so a bubble a frame behind is seen.
const SCROLL_STEP: i32 = 8;

/// The top of a `--scrolling-bubble` window's stripe in `frame`, in surface
/// pixels: a [`SCROLL_STEP`] down each frame, back to the top once the
/// stripe reaches the window's bottom.
pub fn scrolled_to(frame: u32) -> i32 {
    let (_, _, height) = SCROLLING_BUBBLE;
    let steps = (SIZE.1 as i32 - height) / SCROLL_STEP;
    (frame % steps as u32) as i32 * SCROLL_STEP
}

/// A `width` by `height` buffer's bytes: [`COLORS`]`[0]`, with `rows` in
/// [`STRIPE_COLOR`].
fn striped(width: u32, height: u32, rows: std::ops::Range<u32>) -> Vec<u8> {
    (0..height)
        .flat_map(|row| {
            let color = if rows.contains(&row) {
                STRIPE_COLOR
            } else {
                COLORS[0]
            };
            color.to_ne_bytes().repeat(width as usize)
        })
        .collect()
}

/// The popup's fill color, distinct from [`COLORS`] so checks can tell the
/// popup from the window.
pub const POPUP_COLOR: u32 = 0x00_c0_40_20;

/// The two colors frames alternate between, so checks can see the window is
/// still redrawing.
const COLORS: [u32; 2] = [0x00_20_30_50, 0x00_30_50_80];

/// The alpha of a `--translucent` window.
///
/// Half-opaque, so the window is neither invisible nor opaque. Public because
/// `e2e-window-shows-through.sh` greps for `alpha=128` in the compositor log;
/// `the_grepped_log_messages_are_what_the_scripts_expect` keeps them in sync.
pub const TRANSLUCENT_ALPHA: u8 = 0x80;

const _: () = assert!(
    TRANSLUCENT_ALPHA > 0 && TRANSLUCENT_ALPHA < u8::MAX,
    "a clear window has nothing to see and an opaque one is what the check \
     has to tell a background apart from",
);

/// [`COLORS`] at [`TRANSLUCENT_ALPHA`], drawn by a `--translucent` window.
///
/// Public for the same reason as [`TRANSLUCENT_ALPHA`].
pub const TRANSLUCENT_COLORS: [u32; 2] = [translucent(COLORS[0]), translucent(COLORS[1])];

/// One color at [`TRANSLUCENT_ALPHA`], premultiplied as `Argb8888` requires.
///
/// Computed so the translucent colors cannot drift from [`COLORS`].
const fn translucent(color: u32) -> u32 {
    let alpha = TRANSLUCENT_ALPHA as u32;
    let red = ((color >> 16) & 0xff) * alpha / 0xff;
    let green = ((color >> 8) & 0xff) * alpha / 0xff;
    let blue = (color & 0xff) * alpha / 0xff;
    (alpha << 24) | (red << 16) | (green << 8) | blue
}

/// The color a `--format` window draws, as 8-bit `0x00RRGGBB`.
///
/// Public because `guard-buffer-formats.sh` reads it back from the page. Its
/// channels differ, so a swap shows.
pub const DEEP_COLOR: u32 = 0x00_33_66_cc;

/// The two halves of a `--buffer-transform` window's buffer, left then right
/// as drawn, before the turn.
///
/// Public because `guard-buffer-transform.sh` finds them on the page.
pub const TURNED_COLORS: [u32; 2] = [0x00_33_66_cc, 0x00_cc_66_33];

/// The only MIME type this client offers and requests.
///
/// The compositor's `TEXT_MIMES` accepts it.
const TEXT_MIME: &str = "text/plain;charset=utf-8";

/// How long a paste waits for the offering client to write.
///
/// Without a limit, a client that offers a selection and never writes would
/// block this one forever, and a check would only see a window that stopped
/// drawing.
const PASTE_PATIENCE: Duration = Duration::from_secs(5);

/// The `wl_shm` format for a window.
///
/// `Xrgb8888` has no alpha, so an ordinary window is always opaque (see the
/// compositor's `xrgb_forces_opaque_alpha`).
const fn shm_format(translucent: bool) -> wl_shm::Format {
    if translucent {
        wl_shm::Format::Argb8888
    } else {
        wl_shm::Format::Xrgb8888
    }
}

/// The `wl_shm` format `format` names.
const fn deep_shm_format(format: DeepFormat) -> wl_shm::Format {
    match format {
        DeepFormat::Abgr2101010 => wl_shm::Format::Abgr2101010,
        DeepFormat::Xbgr2101010 => wl_shm::Format::Xbgr2101010,
        DeepFormat::Abgr16161616f => wl_shm::Format::Abgr16161616f,
        DeepFormat::Xbgr16161616f => wl_shm::Format::Xbgr16161616f,
    }
}

/// One pixel of 8-bit `0x00RRGGBB` `color` in `format`, little-endian.
///
/// The padding of a format without alpha is left zero, so a compositor that
/// reads it as alpha draws the window transparent.
fn deep_pixel(format: DeepFormat, color: u32) -> Vec<u8> {
    let channel = |shift: u32| (color >> shift) & 0xff;
    let (red, green, blue) = (channel(16), channel(8), channel(0));
    let ten = |value: u32| (value * 1023 + 127) / 255;
    let half = |value: u32| u64::from(half_float(value as f32 / 255.0));
    match format {
        DeepFormat::Abgr2101010 | DeepFormat::Xbgr2101010 => {
            let alpha = if format == DeepFormat::Abgr2101010 {
                3
            } else {
                0
            };
            ((alpha << 30) | (ten(blue) << 20) | (ten(green) << 10) | ten(red))
                .to_le_bytes()
                .to_vec()
        }
        DeepFormat::Abgr16161616f | DeepFormat::Xbgr16161616f => {
            let alpha = if format == DeepFormat::Abgr16161616f {
                u64::from(half_float(1.0))
            } else {
                0
            };
            ((alpha << 48) | (half(blue) << 32) | (half(green) << 16) | half(red))
                .to_le_bytes()
                .to_vec()
        }
    }
}

/// `value`, from 0 to 1, as an IEEE half float, rounded to nearest.
fn half_float(value: f32) -> u16 {
    if value == 0.0 {
        return 0;
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;
    // The mantissa's top 10 bits, rounded on the 11th; a carry steps the
    // exponent, as it should.
    let rounded = (mantissa + 0x1000) >> 13;
    ((exponent as u32) << 10).wrapping_add(rounded) as u16
}

/// The buffer for a `size` window drawn with `transform`: on its side for a
/// quarter turn.
fn buffer_size(size: (u32, u32), transform: Option<wl_output::Transform>) -> (u32, u32) {
    match transform {
        Some(
            wl_output::Transform::_90
            | wl_output::Transform::_270
            | wl_output::Transform::Flipped90
            | wl_output::Transform::Flipped270,
        ) => (size.1, size.0),
        _ => size,
    }
}

/// A `width` by `height` buffer's bytes, [`TURNED_COLORS`]`[0]` on its left
/// half and `[1]` on its right.
fn halves(width: u32, height: u32) -> Vec<u8> {
    let row: Vec<u8> = (0..width)
        .flat_map(|x| TURNED_COLORS[usize::from(x >= width / 2)].to_ne_bytes())
        .collect();
    row.repeat(height as usize)
}

/// Open a window on `$WAYLAND_DISPLAY` and draw until killed.
///
/// Returns only on failure; callers end the client with a signal.
pub fn run(asked: &Arguments) -> Result<std::convert::Infallible, ClientError> {
    let connection =
        Connection::connect_to_env().map_err(|err| ClientError::NoDisplay(err.to_string()))?;
    let mut queue = connection.new_event_queue();
    let handle = queue.handle();
    // Kept to bind globals once the full list arrives, in `Client::bind`.
    let registry = connection.display().get_registry(&handle, ());

    // The first roundtrip delivers the globals. The second delivers what
    // binding produced: `wl_shm` formats and the seat's capabilities.
    let mut client = Client::new(asked);
    queue
        .roundtrip(&mut client)
        .map_err(|err| ClientError::Lost(err.to_string()))?;
    client.bind(&registry, &handle);
    queue
        .roundtrip(&mut client)
        .map_err(|err| ClientError::Lost(err.to_string()))?;

    client.open(&handle)?;
    // Kept so the icon is served while the client runs.
    let _tray = asked
        .tray
        .then(|| crate::tray::show().expect("the session bus takes a tray icon"));
    loop {
        queue
            .blocking_dispatch(&mut client)
            .map_err(|err| ClientError::Lost(err.to_string()))?;
    }
}

/// The bound globals, the window, and the state it is drawn from.
struct Client {
    title: String,
    /// Whether to open a popup once the window is up. See
    /// [`crate::arguments::Arguments::popup`].
    wants_popup: bool,
    /// See [`crate::arguments::Arguments::popup_grab`].
    popup_grab: bool,
    /// Whether the popup has yet to move. See
    /// [`crate::arguments::Arguments::repositioned_popup`].
    repositions: bool,
    /// See [`crate::arguments::Arguments::anchor`].
    anchor: Option<String>,
    /// See [`crate::arguments::Arguments::sliding_menu`].
    sliding_menu: bool,
    /// See [`crate::arguments::Arguments::cursor_surface`]. `drawn` keeps
    /// the cursor surface and its buffers' backing files.
    cursor_surface: bool,
    cursor_drawn: Option<(wl_surface::WlSurface, Vec<std::fs::File>)>,
    /// See [`crate::arguments::Arguments::ask_to_drag`].
    ask_to_drag: Option<AskToDrag>,
    /// See [`crate::arguments::Arguments::constrain_pointer`]. Taken once
    /// asked.
    constrain_pointer: Option<ConstrainPointer>,
    /// See [`crate::arguments::Arguments::constrain_region`].
    constrain_region: Option<(i32, i32, i32, i32)>,
    /// The open popups, each over the one before it or the window.
    popups: Vec<Popup>,
    /// Whether to open a bubble once the window is up. See
    /// [`crate::arguments::Arguments::bubble`].
    wants_bubble: bool,
    bubble: Option<Bubble>,
    /// See [`crate::arguments::Arguments::scrolling_bubble`].
    scrolls: bool,
    /// See [`crate::arguments::Arguments::late_bubble`].
    late_bubble: bool,
    /// See [`crate::arguments::Arguments::bubble_without_input`].
    bubble_without_input: bool,
    /// Whether to open a dialog once the window is up. See
    /// [`crate::arguments::Arguments::dialog`].
    wants_dialog: bool,
    dialog: Option<Dialog>,
    /// The surface the pointer is over, so a press can be told apart.
    pointer_over: Option<wl_surface::WlSurface>,
    /// See [`crate::arguments::Arguments::min_size`].
    min_size: Option<(i32, i32)>,
    max_size: Option<(i32, i32)>,
    /// See [`crate::arguments::Arguments::translucent`]. Kept because buffers
    /// are remade on every rescale and resize.
    translucent: bool,
    /// See [`crate::arguments::Arguments::format`]. Kept for the same reason.
    format: Option<DeepFormat>,
    /// See [`crate::arguments::Arguments::buffer_transform`]. Kept for the
    /// same reason.
    buffer_transform: Option<wl_output::Transform>,
    /// See [`crate::arguments::Arguments::follow_configure`].
    follow_configure: bool,
    /// See [`crate::arguments::Arguments::resize_to`]. Taken when applied.
    resize_to: Option<(u32, u32)>,
    /// See [`crate::arguments::Arguments::viewport_source`].
    viewport_source: Option<(u32, u32)>,
    /// See [`crate::arguments::Arguments::viewport_to`]. Taken when applied.
    viewport_to: Option<(u32, u32)>,
    /// The window's `wp_viewport`, made only when a viewport flag asks.
    viewport: Option<wp_viewport::WpViewport>,
    /// See [`crate::arguments::Arguments::ask_for_focus`].
    ask_for_focus: Option<AskForFocus>,
    /// See [`crate::arguments::Arguments::ask_to`]. Taken once asked.
    ask_to: Option<AskTo>,
    /// See [`crate::arguments::Arguments::xdg_wm_base_v1`].
    xdg_wm_base_v1: bool,
    /// See [`crate::arguments::Arguments::wl_seat_v7`].
    wl_seat_v7: bool,
    /// See [`crate::arguments::Arguments::no_touch`].
    no_touch: bool,
    /// See [`crate::arguments::Arguments::text_input`].
    text_input: bool,
    /// Where `--text-input`'s text cursor is across its field, logical. It
    /// moves right as text is committed.
    caret_x: i32,
    /// The serial of the keyboard's last `enter`, for
    /// [`AskForFocus::WhenLeft`].
    entered_at: Option<u32>,
    /// See [`crate::arguments::Arguments::hold_the_screens_on`].
    hold_the_screens_on: Option<HoldTheScreensOn>,
    /// See [`crate::arguments::Arguments::inhibit_shortcuts`].
    inhibit_shortcuts: Option<TakeTheShortcuts>,
    /// See [`crate::arguments::Arguments::outlive_its_window`].
    outlive_its_window: bool,
    /// See [`crate::arguments::Arguments::ring_the_bell`].
    ring_the_bell: bool,
    /// Whether the toplevel was destroyed under `--outlive-its-window`.
    ///
    /// Stops drawing: the surface remains but has no role to commit frames
    /// to.
    window_is_gone: bool,
    /// See [`Arguments::copy`].
    copy: Option<String>,
    /// See [`Arguments::copy_primary`].
    copy_primary: Option<String>,
    /// See [`Arguments::paste`].
    paste: bool,
    /// See [`Arguments::notify`]. Taken when sent.
    notify: Option<String>,
    /// The bus `notify` was sent on, which must outlive the notification;
    /// see [`crate::notification::notify`].
    notified_on: Option<zbus::blocking::Connection>,
    /// The clipboard and primary selection devices. `None` unless a copy or
    /// paste was requested.
    selections: Option<Selections>,
    /// Whether focus was already requested. Once per window, so the client
    /// does not repeat a request the shell has not answered yet.
    asked: bool,
    /// A configured size not yet applied.
    ///
    /// `xdg_toplevel.configure` carries the size and the following
    /// `xdg_surface.configure` carries the serial that makes it current, so
    /// the size is held until then. Always `None` without
    /// `--follow-configure`, except for the size `--resize-to` applies.
    configured_size: Option<(u32, u32)>,
    globals: Globals,
    /// Set by [`Client::open`] before any event that could draw is
    /// dispatched.
    window: Option<Window>,
    /// Whether the first configure was acknowledged. No buffer may be
    /// attached before then.
    configured: bool,
    /// Which of the two colors the next frame draws.
    frame: u32,
    /// The `wp_cursor_shape_v1` device for the pointer.
    ///
    /// A named shape rather than a cursor surface, so checks can read the
    /// name the compositor passes to the chrome. `None` until the seat has a
    /// pointer.
    cursor: Option<wp_cursor_shape_device_v1::WpCursorShapeDeviceV1>,
    /// Each output's scale.
    ///
    /// Per output because a surface on two screens draws for the denser
    /// one.
    scales: Vec<(ObjectId, i32)>,
    /// Which outputs the surface is currently on.
    entered: Vec<ObjectId>,
    /// The registry name each bound output was announced under.
    ///
    /// `wl_registry.global_remove` identifies outputs by this name, so it is
    /// needed to drop a removed output's `scales` and `entered` entries. No
    /// test removes an output yet, so this path is untested.
    outputs: Vec<(u32, wl_output::WlOutput)>,
}

/// The clipboard and primary selection devices.
///
/// Taken when the window opens, because `selection` events (for pasting) are
/// delivered to a device too.
struct Selections {
    clipboard: wl_data_device::WlDataDevice,
    primary: zwp_primary_selection_device_v1::ZwpPrimarySelectionDeviceV1,
    /// Whether the requested copies were made.
    ///
    /// Once per window: the keyboard can enter many times, and copying again
    /// would overwrite whatever the user copied since.
    copied: bool,
}

/// User data for the `wl_display.sync` that ends a copy. See
/// [`Client::copy_what_was_asked_for`].
struct CopyRole;

/// User data for the `wl_display.sync` after asking again for client-side
/// decorations. See the `org_kde_kwin_server_decoration` dispatch.
struct InsistRole;

/// User data for a popup's objects, so their events reach separate handlers
/// from the window's.
struct PopupRole;

/// An open `--popup` or `--sliding-menu`: one surface drawn in
/// [`POPUP_COLOR`], once at each size it is configured to.
struct Popup {
    surface: wl_surface::WlSurface,
    xdg: xdg_surface::XdgSurface,
    popup: xdg_popup::XdgPopup,
    /// The size its last `xdg_popup.configure` gave it.
    configured: (i32, i32),
    /// The size it last drew at, `None` before its first frame.
    drawn_at: Option<(i32, i32)>,
    /// Its buffers and backing files, kept until the client exits.
    drawn: Vec<(wl_buffer::WlBuffer, std::fs::File)>,
}

/// User data for a bubble's objects. See [`PopupRole`].
struct BubbleRole;

/// An open `--bubble`: a surface drawn in [`POPUP_COLOR`] as a desync
/// subsurface of the window, as Chromium's `WaylandBubble` is.
struct Bubble {
    surface: wl_surface::WlSurface,
    /// `None` once hidden. Chromium hides a bubble by destroying its
    /// `wl_subsurface` and keeps the surface.
    subsurface: Option<wl_subsurface::WlSubsurface>,
    /// Its buffers and backing files, kept until the client exits.
    drawn: Vec<(wl_buffer::WlBuffer, std::fs::File)>,
}

/// User data for `--cursor-surface`'s objects. See [`PopupRole`].
struct CursorRole;

/// User data for a dialog's objects. See [`PopupRole`].
struct DialogRole;

/// An open `--dialog`: a second toplevel drawn once in [`POPUP_COLOR`].
struct Dialog {
    surface: wl_surface::WlSurface,
    toplevel: xdg_toplevel::XdgToplevel,
    /// Its buffer and backing file, created at its first configure.
    drawn: Option<(wl_buffer::WlBuffer, std::fs::File)>,
}

/// The window's surface and its buffers.
struct Window {
    surface: wl_surface::WlSurface,
    /// The parent for a popup.
    xdg: xdg_surface::XdgSurface,
    /// The parent for a dialog.
    toplevel: xdg_toplevel::XdgToplevel,
    pixels: Pixels,
    /// The surface size, in surface-local pixels.
    ///
    /// Changes only under `--follow-configure`. Stored with the buffers
    /// because both must change together.
    size: (u32, u32),
    /// The buffer scale these pixels were made for. The surface size does not
    /// change with it.
    scale: i32,
}

/// What a window's buffers hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Paint {
    /// [`COLORS`], alternating per frame.
    Opaque,
    /// [`TRANSLUCENT_COLORS`], alternating per frame.
    Translucent,
    /// [`halves`], for a `--buffer-transform` window. Opaque.
    Halves,
    /// [`striped`] at [`scrolled_to`] the frame, drawn anew each frame, for a
    /// `--scrolling-bubble` window. Opaque.
    Scrolled,
    /// [`DEEP_COLOR`] in a `--format` window's format, every frame.
    Deep(DeepFormat),
}

impl Paint {
    /// The `wl_shm` format the buffers hold.
    ///
    /// `Xrgb8888` has no alpha, so an ordinary window is always opaque (see
    /// the compositor's `xrgb_forces_opaque_alpha`).
    const fn shm_format(self) -> wl_shm::Format {
        match self {
            Paint::Deep(format) => deep_shm_format(format),
            Paint::Translucent => shm_format(true),
            Paint::Opaque | Paint::Halves | Paint::Scrolled => shm_format(false),
        }
    }

    /// Bytes a pixel.
    const fn bytes_per_pixel(self) -> u32 {
        match self {
            Paint::Deep(DeepFormat::Abgr16161616f | DeepFormat::Xbgr16161616f) => 8,
            _ => 4,
        }
    }
}

/// Two buffers in one shared file, used alternately.
///
/// Allocated once rather than per frame, to keep memory traffic out of
/// timing-sensitive checks. Each frame draws into the buffer the compositor
/// has released.
struct Pixels {
    /// Written with `pwrite` rather than mapped; the compositor's
    /// `MAP_SHARED` mapping sees the writes, and no `unsafe` is needed.
    file: std::fs::File,
    buffers: [wl_buffer::WlBuffer; 2],
    /// Whether the compositor still holds each buffer. Drawing into a held
    /// buffer would change the displayed frame.
    held: [bool; 2],
    /// Bytes in one buffer, which is also the second buffer's offset.
    each: usize,
    /// Each color as a full buffer's bytes.
    ///
    /// Lets a frame be one `pwrite` with no allocation.
    colors: [Vec<u8>; 2],
}

/// The advertised globals, and those bound from them.
#[derive(Default)]
struct Globals {
    gestures: Option<zwp_pointer_gestures_v1::ZwpPointerGesturesV1>,
    relative: Option<zwp_relative_pointer_manager_v1::ZwpRelativePointerManagerV1>,
    constraints: Option<zwp_pointer_constraints_v1::ZwpPointerConstraintsV1>,
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    /// For `--bubble`.
    subcompositor: Option<wl_subcompositor::WlSubcompositor>,
    wm_base: Option<xdg_wm_base::XdgWmBase>,
    cursor: Option<wp_cursor_shape_manager_v1::WpCursorShapeManagerV1>,
    activation: Option<xdg_activation_v1::XdgActivationV1>,
    bell: Option<xdg_system_bell_v1::XdgSystemBellV1>,
    /// For `--hold-the-screens-on`.
    inhibit: Option<zwp_idle_inhibit_manager_v1::ZwpIdleInhibitManagerV1>,
    /// For `--inhibit-shortcuts`.
    shortcuts_inhibit:
        Option<zwp_keyboard_shortcuts_inhibit_manager_v1::ZwpKeyboardShortcutsInhibitManagerV1>,
    /// Kept because the selection devices are created from the seat.
    seat: Option<wl_seat::WlSeat>,
    /// For `--text-input`.
    text_input: Option<zwp_text_input_manager_v3::ZwpTextInputManagerV3>,
    clipboard: Option<wl_data_device_manager::WlDataDeviceManager>,
    /// The primary selection manager, a separate global from the clipboard's.
    primary: Option<zwp_primary_selection_device_manager_v1::ZwpPrimarySelectionDeviceManagerV1>,
    /// Decoration negotiation as Chromium, Electron and Qt do it.
    decoration: Option<zxdg_decoration_manager_v1::ZxdgDecorationManagerV1>,
    /// Decoration negotiation as GTK3 does it.
    kde_decoration:
        Option<org_kde_kwin_server_decoration_manager::OrgKdeKwinServerDecorationManager>,
    /// For `--anchor`.
    anchors: Option<domicile_anchor_manager_v1::DomicileAnchorManagerV1>,
    /// Window export as GTK3 does it, for `tests/xdg_foreign.rs`.
    exporter_v1: Option<zxdg_exporter_v1::ZxdgExporterV1>,
    /// Window export as GTK4, Chromium and Electron do it.
    exporter_v2: Option<zxdg_exporter_v2::ZxdgExporterV2>,
    /// The scale the compositor prefers for the window, as kitty and GTK 4
    /// read it on a fractional display.
    fractional_scale: Option<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1>,
    /// For `--viewport-source` and `--viewport-to`.
    viewporter: Option<wp_viewporter::WpViewporter>,
    named: Vec<(u32, String, u32)>,
}

impl Client {
    fn new(asked: &Arguments) -> Client {
        Client {
            title: asked.title.clone(),
            wants_popup: asked.popup,
            popup_grab: asked.popup_grab,
            repositions: asked.repositioned_popup,
            anchor: asked.anchor.clone(),
            sliding_menu: asked.sliding_menu,
            cursor_surface: asked.cursor_surface,
            cursor_drawn: None,
            ask_to_drag: asked.ask_to_drag,
            constrain_pointer: asked.constrain_pointer,
            constrain_region: asked.constrain_region,
            popups: Vec::new(),
            wants_bubble: asked.bubble || asked.bubble_without_input || asked.scrolling_bubble,
            bubble: None,
            scrolls: asked.scrolling_bubble,
            late_bubble: asked.late_bubble,
            bubble_without_input: asked.bubble_without_input,
            wants_dialog: asked.dialog,
            dialog: None,
            pointer_over: None,
            min_size: asked.min_size,
            max_size: asked.max_size,
            translucent: asked.translucent,
            format: asked.format,
            buffer_transform: asked.buffer_transform,
            follow_configure: asked.follow_configure,
            resize_to: asked.resize_to,
            viewport_source: asked.viewport_source,
            viewport_to: asked.viewport_to,
            viewport: None,
            ask_for_focus: asked.ask_for_focus,
            ask_to: asked.ask_to,
            xdg_wm_base_v1: asked.xdg_wm_base_v1,
            wl_seat_v7: asked.wl_seat_v7,
            no_touch: asked.no_touch,
            text_input: asked.text_input,
            caret_x: CARET.0,
            entered_at: None,
            hold_the_screens_on: asked.hold_the_screens_on,
            inhibit_shortcuts: asked.inhibit_shortcuts,
            outlive_its_window: asked.outlive_its_window,
            ring_the_bell: asked.ring_the_bell,
            window_is_gone: false,
            copy: asked.copy.clone(),
            copy_primary: asked.copy_primary.clone(),
            paste: asked.paste,
            notify: asked.notify.clone(),
            notified_on: None,
            selections: None,
            asked: false,
            configured_size: None,
            globals: Globals::default(),
            window: None,
            configured: false,
            frame: 0,
            cursor: None,
            scales: Vec::new(),
            entered: Vec::new(),
            outputs: Vec::new(),
        }
    }

    /// Bind the advertised globals.
    ///
    /// Runs after the whole list arrives. Each global is bound at no more
    /// than the version the compositor offered, since binding higher is a
    /// protocol error.
    fn bind(&mut self, registry: &wl_registry::WlRegistry, handle: &QueueHandle<Client>) {
        let named = std::mem::take(&mut self.globals.named);
        for (name, interface, version) in named {
            match interface.as_str() {
                "wl_compositor" => {
                    self.globals.compositor = Some(registry.bind(name, version.min(4), handle, ()));
                }
                "wl_shm" => {
                    self.globals.shm = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "wl_subcompositor" => {
                    self.globals.subcompositor =
                        Some(registry.bind(name, version.min(1), handle, ()));
                }
                // 6 for the `suspended` state, sent only to clients that bind 6.
                "xdg_wm_base" => {
                    let newest = if self.xdg_wm_base_v1 { 1 } else { 6 };
                    self.globals.wm_base =
                        Some(registry.bind(name, version.min(newest), handle, ()));
                }
                "wp_cursor_shape_manager_v1" => {
                    self.globals.cursor = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zwp_pointer_constraints_v1" => {
                    self.globals.constraints = Some(registry.bind(name, 1, handle, ()));
                }
                "zwp_relative_pointer_manager_v1" => {
                    self.globals.relative = Some(registry.bind(name, 1, handle, ()));
                }
                "zwp_pointer_gestures_v1" => {
                    self.globals.gestures = Some(registry.bind(name, version.min(3), handle, ()));
                }
                "xdg_activation_v1" => {
                    self.globals.activation = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "xdg_system_bell_v1" => {
                    self.globals.bell = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zwp_idle_inhibit_manager_v1" => {
                    self.globals.inhibit = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "domicile_anchor_manager_v1" => {
                    self.globals.anchors = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zwp_text_input_manager_v3" => {
                    self.globals.text_input = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zwp_keyboard_shortcuts_inhibit_manager_v1" => {
                    self.globals.shortcuts_inhibit =
                        Some(registry.bind(name, version.min(1), handle, ()));
                }
                // Binding the seat lets the compositor send input. It is
                // kept to create the selection devices.
                "wl_seat" => {
                    let newest = if self.wl_seat_v7 { 7 } else { 5 };
                    self.globals.seat = Some(registry.bind(name, version.min(newest), handle, ()));
                }
                "wl_data_device_manager" => {
                    self.globals.clipboard = Some(registry.bind(name, version.min(3), handle, ()));
                }
                "zwp_primary_selection_device_manager_v1" => {
                    self.globals.primary = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zxdg_decoration_manager_v1" => {
                    self.globals.decoration = Some(registry.bind(name, version.min(1), handle, ()));
                }
                "org_kde_kwin_server_decoration_manager" => {
                    self.globals.kde_decoration =
                        Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zxdg_exporter_v1" => {
                    self.globals.exporter_v1 =
                        Some(registry.bind(name, version.min(1), handle, ()));
                }
                "zxdg_exporter_v2" => {
                    self.globals.exporter_v2 =
                        Some(registry.bind(name, version.min(1), handle, ()));
                }
                "wp_fractional_scale_manager_v1" => {
                    self.globals.fractional_scale =
                        Some(registry.bind(name, version.min(1), handle, ()));
                }
                "wp_viewporter" => {
                    self.globals.viewporter = Some(registry.bind(name, version.min(1), handle, ()));
                }
                _ => {}
            }
        }
    }

    /// Create the surface and buffers, and request a toplevel.
    fn open(&mut self, handle: &QueueHandle<Client>) -> Result<(), ClientError> {
        // Before the surface exists, so a selection can be offered as soon
        // as the window gets focus.
        self.take_selection_devices(handle)?;
        let compositor = self
            .globals
            .compositor
            .as_ref()
            .ok_or(ClientError::Missing {
                global: "wl_compositor",
            })?;
        let wm_base = self.globals.wm_base.as_ref().ok_or(ClientError::Missing {
            global: "xdg_wm_base",
        })?;
        // Checked here so a missing `wl_shm` is an error `run` returns, not a
        // window that silently never maps.
        let shm = self
            .globals
            .shm
            .as_ref()
            .ok_or(ClientError::Missing { global: "wl_shm" })?;
        // Required: the cursor-shape request is how the compositor learns of a
        // cursor to pass to the chrome. Without the manager,
        // `tests/input.rs::a_pointer_over_a_window_asks_the_chrome_for_that_window_s_cursor`
        // would fail and blame the compositor for the client's gap.
        if self.globals.cursor.is_none() {
            return Err(ClientError::Missing {
                global: "wp_cursor_shape_manager_v1",
            });
        }

        let surface = compositor.create_surface(handle, ());
        // For `--hold-the-screens-on-before-it-has-a-window`: the surface has
        // no role yet.
        if self.hold_the_screens_on == Some(HoldTheScreensOn::BeforeItHasAWindow) {
            self.take_an_inhibitor(&surface, handle)?;
        }
        if self.inhibit_shortcuts == Some(TakeTheShortcuts::BeforeItHasAWindow) {
            self.take_the_shortcuts(&surface, handle)?;
        }
        let xdg = wm_base.get_xdg_surface(&surface, handle, ());
        let toplevel = xdg.get_toplevel(handle, ());
        toplevel.set_title(self.title.clone());
        crate::say!(toplevel.id(), "set_title(\"{}\")", self.title);
        // Chromes identify windows by app id; the title is for people.
        toplevel.set_app_id("dev.domicile.test-client".to_string());
        if let Some((width, height)) = self.min_size {
            toplevel.set_min_size(width, height);
        }
        if let Some((width, height)) = self.max_size {
            toplevel.set_max_size(width, height);
        }
        // Request client-side decorations, which `tests/decorations.rs`
        // checks. Sent before the first commit so the answer arrives with the
        // first configure.
        if let Some(manager) = &self.globals.decoration {
            let decoration = manager.get_toplevel_decoration(&toplevel, handle, ());
            decoration.set_mode(zxdg_toplevel_decoration_v1::Mode::ClientSide);
        }
        if let Some(manager) = &self.globals.kde_decoration {
            let decoration = manager.create(&surface, handle, ());
            decoration.request_mode(org_kde_kwin_server_decoration::Mode::Client);
        }
        if let Some(name) = &self.anchor {
            let manager = self.globals.anchors.as_ref().ok_or(ClientError::Missing {
                global: "domicile_anchor_manager_v1",
            })?;
            let anchor = manager.get_toplevel_anchor(&toplevel, handle, ());
            anchor.set_anchor(Some(name.clone()));
            crate::say!(anchor.id(), "set_anchor({name})");
        }
        // Export the window as a toolkit does before a portal call;
        // `tests/xdg_foreign.rs` checks the handles.
        if let Some(exporter) = &self.globals.exporter_v1 {
            exporter.export(&surface, handle, ());
        }
        if let Some(exporter) = &self.globals.exporter_v2 {
            exporter.export_toplevel(&surface, handle, ());
        }
        // Only traced: the window keeps drawing at its integer scale.
        if let Some(manager) = &self.globals.fractional_scale {
            manager.get_fractional_scale(&surface, handle, ());
        }
        if self.viewport_source.is_some() || self.viewport_to.is_some() {
            let viewporter = self
                .globals
                .viewporter
                .as_ref()
                .ok_or(ClientError::Missing {
                    global: "wp_viewporter",
                })?;
            let viewport = viewporter.get_viewport(&surface, handle, ());
            if let Some((width, height)) = self.viewport_source {
                viewport.set_source(0.0, 0.0, f64::from(width), f64::from(height));
                crate::say!(viewport.id(), "set_source(0, 0, {}, {})", width, height);
            }
            self.viewport = Some(viewport);
        }
        // Scale 1: the surface has entered no output until it maps. `follow`
        // rescales on `wl_surface.enter`.
        if let Some(transform) = self.buffer_transform {
            surface.set_buffer_transform(transform);
            crate::say!(surface.id(), "set_buffer_transform({:?})", transform);
        }
        let pixels = Pixels::new(
            shm,
            handle,
            buffer_size(SIZE, self.buffer_transform),
            self.paint(),
        )?;
        // The initial commit must carry no buffer; the compositor answers it
        // with the first configure.
        surface.commit();
        if self.hold_the_screens_on == Some(HoldTheScreensOn::OnItsWindow) {
            self.take_an_inhibitor(&surface, handle)?;
        }
        if self.inhibit_shortcuts == Some(TakeTheShortcuts::OnItsWindow) {
            self.take_the_shortcuts(&surface, handle)?;
        }
        if self.text_input {
            self.edit_text(handle)?;
        }
        self.window = Some(Window {
            surface,
            xdg,
            toplevel,
            pixels,
            size: SIZE,
            scale: 1,
        });
        Ok(())
    }

    /// Create an idle inhibitor on `surface`.
    ///
    /// The inhibitor is never destroyed: `wayland-client` sends no destructor
    /// on drop, so it lasts until the client disconnects.
    fn take_an_inhibitor(
        &self,
        surface: &wl_surface::WlSurface,
        handle: &QueueHandle<Client>,
    ) -> Result<(), ClientError> {
        let inhibit = self.globals.inhibit.as_ref().ok_or(ClientError::Missing {
            global: "zwp_idle_inhibit_manager_v1",
        })?;
        let inhibitor = inhibit.create_inhibitor(surface, handle, ());
        crate::say!(inhibitor.id(), "create_inhibitor({})", surface.id());
        Ok(())
    }
    /// Become a text editor for `--text-input`: a `zwp_text_input_v3` on the
    /// seat, enabled each time the keyboard enters.
    fn edit_text(&mut self, handle: &QueueHandle<Client>) -> Result<(), ClientError> {
        let manager = self
            .globals
            .text_input
            .as_ref()
            .ok_or(ClientError::Missing {
                global: "zwp_text_input_manager_v3",
            })?;
        let seat = self
            .globals
            .seat
            .as_ref()
            .ok_or(ClientError::Missing { global: "wl_seat" })?;
        let text_input = manager.get_text_input(seat, handle, ());
        crate::say!(text_input.id(), "get_text_input()");
        Ok(())
    }

    /// Create a keyboard shortcuts inhibitor on `surface`, never destroyed, as
    /// [`Client::take_an_inhibitor`] is.
    fn take_the_shortcuts(
        &self,
        surface: &wl_surface::WlSurface,
        handle: &QueueHandle<Client>,
    ) -> Result<(), ClientError> {
        let manager = self
            .globals
            .shortcuts_inhibit
            .as_ref()
            .ok_or(ClientError::Missing {
                global: "zwp_keyboard_shortcuts_inhibit_manager_v1",
            })?;
        let seat = self
            .globals
            .seat
            .as_ref()
            .ok_or(ClientError::Missing { global: "wl_seat" })?;
        let inhibitor = manager.inhibit_shortcuts(surface, seat, handle, ());
        crate::say!(inhibitor.id(), "inhibit_shortcuts({})", surface.id());
        Ok(())
    }

    /// Create the clipboard and primary selection devices, if copy or paste
    /// was requested.
    ///
    /// A missing manager is an error, so a compositor without one fails here
    /// rather than in a check that never ran.
    fn take_selection_devices(&mut self, handle: &QueueHandle<Client>) -> Result<(), ClientError> {
        if self.copy.is_none() && self.copy_primary.is_none() && !self.paste {
            return Ok(());
        }
        let seat = self
            .globals
            .seat
            .as_ref()
            .ok_or(ClientError::Missing { global: "wl_seat" })?;
        let clipboard = self
            .globals
            .clipboard
            .as_ref()
            .ok_or(ClientError::Missing {
                global: "wl_data_device_manager",
            })?;
        let primary = self.globals.primary.as_ref().ok_or(ClientError::Missing {
            global: "zwp_primary_selection_device_manager_v1",
        })?;
        self.selections = Some(Selections {
            clipboard: clipboard.get_data_device(seat, handle, ()),
            primary: primary.get_device(seat, handle, ()),
            copied: false,
        });
        Ok(())
    }

    /// Offer the requested text on each selection.
    ///
    /// Called on keyboard enter, because the protocol denies `set_selection`
    /// from an unfocused client.
    ///
    /// The serial is `0`. The protocol wants the serial of the triggering
    /// input event, which this client never had; Smithay checks focus, not
    /// the serial.
    ///
    /// A copy ends with a `wl_display.sync` whose `done` traces
    /// `copy handled`. The compositor handles requests in order, so after that
    /// line a check can move the keyboard away without getting the
    /// `set_selection` requests denied.
    fn copy_what_was_asked_for(&mut self, connection: &Connection, handle: &QueueHandle<Client>) {
        // Most clients copy nothing and have no devices.
        let Some(selections) = &mut self.selections else {
            return;
        };
        if selections.copied {
            return;
        }
        selections.copied = true;
        if self.copy.is_some() {
            let manager = self
                .globals
                .clipboard
                .as_ref()
                .expect("a device was taken, so there was a manager to take it from");
            let source = manager.create_data_source(handle, ());
            source.offer(TEXT_MIME.to_string());
            selections.clipboard.set_selection(Some(&source), 0);
            crate::say!(selections.clipboard.id(), "set_selection({})", source.id());
        }
        if self.copy_primary.is_some() {
            let manager = self
                .globals
                .primary
                .as_ref()
                .expect("a device was taken, so there was a manager to take it from");
            let source = manager.create_source(handle, ());
            source.offer(TEXT_MIME.to_string());
            selections.primary.set_selection(Some(&source), 0);
            crate::say!(selections.primary.id(), "set_selection({})", source.id());
        }
        if self.copy.is_some() || self.copy_primary.is_some() {
            connection.display().sync(handle, CopyRole);
        }
    }

    /// Request an activation token for this window's surface, made for the
    /// input or focus event `serial`.
    ///
    /// `None` sends no serial or seat, which the protocol allows. Checks use
    /// it as the kind of request a focus policy should refuse.
    fn ask_for_the_keyboard(
        &self,
        handle: &QueueHandle<Client>,
        serial: Option<u32>,
    ) -> Result<(), ClientError> {
        let activation = self
            .globals
            .activation
            .as_ref()
            .ok_or(ClientError::Missing {
                global: "xdg_activation_v1",
            })?;
        let window = self.window.as_ref().ok_or(ClientError::Missing {
            global: "a mapped window",
        })?;
        let token = activation.get_activation_token(handle, window.surface.clone());
        token.set_surface(&window.surface);
        if let (Some(serial), Some(seat)) = (serial, self.globals.seat.as_ref()) {
            token.set_serial(serial, seat);
        }
        token.commit();
        crate::say!(token.id(), "commit()");
        Ok(())
    }

    /// The highest scale among the outputs the surface is on.
    ///
    /// `None` before the first `wl_surface.enter`, and after the surface leaves
    /// its last output. The caller keeps the current scale then, rather than
    /// dropping to 1x and back.
    fn wanted_scale(&self) -> Option<i32> {
        self.entered
            .iter()
            .filter_map(|on| self.scales.iter().find(|(id, _)| id == on))
            .map(|(_, scale)| *scale)
            .max()
    }

    /// Rebuild the buffers if the wanted scale changed.
    ///
    /// The buffer grows and the surface does not; `tests/density.rs` checks
    /// this.
    fn follow(&mut self, handle: &QueueHandle<Client>) -> Result<(), ClientError> {
        let paint = self.paint();
        // On no output: keep the current scale.
        let Some(wanted) = self.wanted_scale() else {
            return Ok(());
        };
        // Outputs announce their scale before `open` creates the surface.
        let Some(window) = self.window.as_mut() else {
            return Ok(());
        };
        if window.scale == wanted {
            return Ok(());
        }
        let shm = self
            .globals
            .shm
            .as_ref()
            .expect("open() proved there is a wl_shm before there was a window");

        window.surface.set_buffer_scale(wanted);
        crate::say!(window.surface.id(), "set_buffer_scale({})", wanted);
        // Destroy rather than drop: dropping a proxy sends no destructor, so
        // the old buffers would stay alive, keep the old pool mapped, and keep
        // delivering `release` events. The compositor keeps what it still
        // needs to read.
        for buffer in &window.pixels.buffers {
            buffer.destroy();
        }
        window.pixels = Pixels::new(
            shm,
            handle,
            buffer_size(
                (window.size.0 * wanted as u32, window.size.1 * wanted as u32),
                self.buffer_transform,
            ),
            paint,
        )?;
        window.scale = wanted;
        Ok(())
    }

    /// Rebuild the buffers at the configured size, if it changed.
    ///
    /// Used by `--follow-configure`, where the client acts as the chrome and
    /// must fill the size the compositor gives it. Returns `false` when there
    /// is nothing to do.
    fn resize(&mut self, handle: &QueueHandle<Client>) -> Result<bool, ClientError> {
        let paint = self.paint();
        let Some(wanted) = self.configured_size.take() else {
            return Ok(false);
        };
        let Some(window) = self.window.as_mut() else {
            return Ok(false);
        };
        if window.size == wanted {
            return Ok(false);
        }
        let shm = self
            .globals
            .shm
            .as_ref()
            .expect("open() proved there is a wl_shm before there was a window");

        // Destroy rather than drop; see `follow`.
        for buffer in &window.pixels.buffers {
            buffer.destroy();
        }
        window.pixels = Pixels::new(
            shm,
            handle,
            buffer_size(
                (
                    wanted.0 * window.scale as u32,
                    wanted.1 * window.scale as u32,
                ),
                self.buffer_transform,
            ),
            paint,
        )?;
        window.size = wanted;
        Ok(true)
    }

    /// What the window's buffers hold.
    fn paint(&self) -> Paint {
        if let Some(format) = self.format {
            return Paint::Deep(format);
        }
        match (self.scrolls, self.buffer_transform, self.translucent) {
            (true, _, _) => Paint::Scrolled,
            (false, Some(_), _) => Paint::Halves,
            (false, None, true) => Paint::Translucent,
            (false, None, false) => Paint::Opaque,
        }
    }

    /// Draw one frame and ask to be woken for the next.
    fn draw(&mut self, handle: &QueueHandle<Client>) -> Result<(), ClientError> {
        let color = (self.frame % 2) as usize;
        let paint = self.paint();
        let top = scrolled_to(self.frame);
        let window = self
            .window
            .as_mut()
            .expect("open() runs before anything that could draw");
        let (width, height) = window.size;

        // Request the next frame callback every time, even when no buffer is
        // free, or the client would never wake again.
        window.surface.frame(handle, ());
        // `None` means both buffers are held, so this commits only the frame
        // request. A compositor that held both past the callback would make
        // this loop spin; this one releases a buffer every frame.
        let drew = match window.pixels.free() {
            Some(index) => {
                match paint {
                    Paint::Scrolled => {
                        let scale = window.scale as u32;
                        let (_, _, stripe) = SCROLLING_BUBBLE;
                        let rows = top as u32 * scale..(top + stripe) as u32 * scale;
                        window
                            .pixels
                            .write(index, &striped(width * scale, height * scale, rows))?;
                        // A sync subsurface's move applies on this commit,
                        // with the content it sits on.
                        let subsurface = self
                            .bubble
                            .as_ref()
                            .and_then(|bubble| bubble.subsurface.as_ref());
                        let at = if self.late_bubble {
                            scrolled_to(self.frame.saturating_sub(1))
                        } else {
                            top
                        };
                        if let Some(subsurface) = subsurface {
                            subsurface.set_position(SCROLLING_BUBBLE.0, at);
                        }
                    }
                    Paint::Opaque | Paint::Translucent | Paint::Halves | Paint::Deep(_) => {
                        window.pixels.fill(index, color)?;
                    }
                }
                window
                    .surface
                    .attach(Some(&window.pixels.buffers[index]), 0, 0);
                window.surface.damage(0, 0, width as i32, height as i32);
                window.pixels.held[index] = true;
                true
            }
            None => false,
        };
        window.surface.commit();
        // Advance per frame drawn, not per buffer, so colors still alternate
        // if the compositor always releases the same buffer first.
        if drew {
            self.frame = self.frame.wrapping_add(1);
        }
        Ok(())
    }
}

impl Pixels {
    fn new(
        shm: &wl_shm::WlShm,
        handle: &QueueHandle<Client>,
        (width, height): (u32, u32),
        paint: Paint,
    ) -> Result<Pixels, ClientError> {
        let bytes_per_pixel = paint.bytes_per_pixel();
        let each = (width as usize) * (height as usize) * bytes_per_pixel as usize;
        let file = anonymous(each * 2)
            .map_err(|err| ClientError::NoBuffer(format!("no memory to draw in: {err}")))?;
        let pool = shm.create_pool(file.as_fd(), (each * 2) as i32, handle, ());
        let buffers = [0usize, 1].map(|index| {
            pool.create_buffer(
                (index * each) as i32,
                width as i32,
                height as i32,
                (width * bytes_per_pixel) as i32,
                paint.shm_format(),
                handle,
                index,
            )
        });
        // The buffers keep the pool alive on the compositor side.
        pool.destroy();
        let flat = |painted: [u32; 2]| {
            painted.map(|color| {
                color
                    .to_ne_bytes()
                    .iter()
                    .copied()
                    .cycle()
                    .take(each)
                    .collect()
            })
        };
        let colors = match paint {
            Paint::Opaque => flat(COLORS),
            Paint::Translucent => flat(TRANSLUCENT_COLORS),
            Paint::Halves => [halves(width, height), halves(width, height)],
            Paint::Deep(format) => {
                let frame = deep_pixel(format, DEEP_COLOR).repeat(each / bytes_per_pixel as usize);
                [frame.clone(), frame]
            }
            // Drawn anew each frame by `write`.
            Paint::Scrolled => [Vec::new(), Vec::new()],
        };
        Ok(Pixels {
            file,
            buffers,
            held: [false, false],
            each,
            colors,
        })
    }

    /// A buffer the compositor has given back, if there is one.
    fn free(&self) -> Option<usize> {
        self.held.iter().position(|held| !held)
    }

    /// Fill one buffer with one of the two flat colors.
    fn fill(&self, index: usize, color: usize) -> Result<(), ClientError> {
        self.write(index, &self.colors[color])
    }

    /// Write a whole buffer's `bytes` into one buffer.
    fn write(&self, index: usize, bytes: &[u8]) -> Result<(), ClientError> {
        assert_eq!(bytes.len(), self.each, "a frame fills its whole buffer");
        self.file
            .write_all_at(bytes, (index * self.each) as u64)
            .map_err(|err| ClientError::NoBuffer(format!("could not fill the buffer: {err}")))
    }
}

/// An unlinked file of `bytes` bytes to share pixels through.
///
/// A temp file rather than `memfd`, which some test machines lack. Unlinked
/// at once so nothing is left in `$XDG_RUNTIME_DIR`, which some checks
/// assert.
fn anonymous(bytes: usize) -> std::io::Result<std::fs::File> {
    let directory = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let path = directory.join(format!("domicile-test-client-{}", std::process::id()));
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)?;
    std::fs::remove_file(&path)?;
    file.set_len(bytes as u64)?;
    Ok(file)
}

/// Request focus once, if it was asked for at `when`, with `serial`.
///
/// This mints a token; the token's `done` handler sends the activation.
fn ask_for_focus_or_stop(
    client: &mut Client,
    handle: &QueueHandle<Client>,
    when: AskForFocus,
    serial: Option<u32>,
) {
    if client.ask_for_focus == Some(when) && !client.asked {
        client.asked = true;
        if let Err(err) = client.ask_for_the_keyboard(handle, serial) {
            crate::say!("client", "cannot ask for the keyboard: {err}");
        }
    }
}

/// Ring the bell for `--ring-the-bell`, once: with the window, then without.
fn ring_the_bell(client: &mut Client) {
    if !client.ring_the_bell {
        return;
    }
    client.ring_the_bell = false;
    let bell = client
        .globals
        .bell
        .as_ref()
        .expect("--ring-the-bell needs xdg_system_bell_v1");
    let window = client
        .window
        .as_ref()
        .expect("the bell rings once the window is mapped");
    bell.ring(Some(&window.surface));
    bell.ring(None);
}

/// Open the `--popup` over the window, once.
fn open_popup(client: &mut Client, handle: &QueueHandle<Client>) {
    if !client.wants_popup {
        return;
    }
    client.wants_popup = false;
    let window = client
        .window
        .as_ref()
        .expect("a popup opens once the window is mapped")
        .xdg
        .clone();
    open_a_popup(client, handle, &window, false);
}

/// Open a `--sliding-menu` over the surface just pressed, the window or a
/// menu.
fn open_a_sliding_menu(client: &mut Client, handle: &QueueHandle<Client>) {
    let pressed = client.pointer_over.as_ref();
    let parent = client
        .window
        .iter()
        .map(|window| (&window.surface, &window.xdg))
        .chain(
            client
                .popups
                .iter()
                .map(|popup| (&popup.surface, &popup.xdg)),
        )
        .find(|(surface, _)| Some(*surface) == pressed)
        .map(|(_, xdg)| xdg.clone())
        .expect("a press is over the window or one of its menus");
    open_a_popup(client, handle, &parent, true);
}

/// Draw `--cursor-surface`'s cursor at `size`, setting it as the pointer's
/// cursor on `entered`, the pointer and its enter serial.
fn draw_the_cursor(
    client: &mut Client,
    handle: &QueueHandle<Client>,
    entered: Option<(&wl_pointer::WlPointer, u32)>,
    size: (i32, i32),
) {
    let (Some(compositor), Some(shm)) = (
        client.globals.compositor.as_ref(),
        client.globals.shm.as_ref(),
    ) else {
        unreachable!("open() refuses a compositor without these");
    };
    let (surface, files) = client
        .cursor_drawn
        .get_or_insert_with(|| (compositor.create_surface(handle, CursorRole), Vec::new()));
    if let Some((pointer, serial)) = entered {
        pointer.set_cursor(serial, Some(surface), 1, 2);
        crate::say!(
            pointer.id(),
            "set_cursor({}, {}, 1, 2)",
            serial,
            surface.id()
        );
    }
    let (buffer, file) = solid_or_stop(shm, handle, size, CursorRole);
    surface.attach(Some(&buffer), 0, 0);
    surface.damage_buffer(0, 0, size.0, size.1);
    surface.commit();
    crate::say!(surface.id(), "cursor_drawn({}, {})", size.0, size.1);
    files.push(file);
}

/// Ask, once, for `--constrain-pointer`'s lock or confinement over the window
/// the pointer entered.
fn constrain_the_pointer(
    client: &mut Client,
    handle: &QueueHandle<Client>,
    pointer: &wl_pointer::WlPointer,
    entered: &wl_surface::WlSurface,
) {
    let Some(window) = client
        .window
        .as_ref()
        .filter(|window| window.surface == *entered)
    else {
        return;
    };
    let (Some(constraint), Some(constraints)) = (
        client.constrain_pointer.take(),
        client.globals.constraints.as_ref(),
    ) else {
        return;
    };
    let lifetime = zwp_pointer_constraints_v1::Lifetime::Persistent;
    let region = client.constrain_region.map(|(x, y, width, height)| {
        let region = client
            .globals
            .compositor
            .as_ref()
            .expect("a client with a window has a compositor")
            .create_region(handle, ());
        region.add(x, y, width, height);
        region
    });
    match constraint {
        ConstrainPointer::Lock => {
            let locked = constraints.lock_pointer(
                &window.surface,
                pointer,
                region.as_ref(),
                lifetime,
                handle,
                (),
            );
            crate::say!(locked.id(), "lock_pointer()");
        }
        ConstrainPointer::Confine => {
            let confined = constraints.confine_pointer(
                &window.surface,
                pointer,
                region.as_ref(),
                lifetime,
                handle,
                (),
            );
            crate::say!(confined.id(), "confine_pointer()");
        }
    }
    if let Some(region) = region {
        region.destroy();
    }
}

/// Ask the desktop to move or resize the window from the button event
/// `serial`.
fn ask_to_drag(client: &Client, drag: AskToDrag, serial: u32) {
    let toplevel = &client
        .window
        .as_ref()
        .expect("a press reaches only a client with a window")
        .toplevel;
    let seat = client
        .globals
        .seat
        .as_ref()
        .expect("a press comes from the seat");
    match drag {
        AskToDrag::Move | AskToDrag::MoveAfterRelease => {
            toplevel._move(seat, serial);
            crate::say!(toplevel.id(), "move({})", serial);
        }
        AskToDrag::ResizeBottomRight => {
            toplevel.resize(seat, serial, xdg_toplevel::ResizeEdge::BottomRight);
            crate::say!(toplevel.id(), "resize({}, bottom_right)", serial);
        }
    }
}

/// Open a [`POPUP`] over `parent`, sliding on both axes if `slides`.
///
/// Anchored by a positioner, with a first commit carrying no buffer.
fn open_a_popup(
    client: &mut Client,
    handle: &QueueHandle<Client>,
    parent: &xdg_surface::XdgSurface,
    slides: bool,
) {
    let (Some(compositor), Some(wm_base)) = (
        client.globals.compositor.as_ref(),
        client.globals.wm_base.as_ref(),
    ) else {
        unreachable!("open() refuses a compositor without these");
    };
    let positioner = positioner(wm_base, handle, POPUP, slides);
    let (_, _, width, height) = POPUP;
    let surface = compositor.create_surface(handle, PopupRole);
    let xdg = wm_base.get_xdg_surface(&surface, handle, PopupRole);
    let popup = xdg.get_popup(Some(parent), &positioner, handle, PopupRole);
    positioner.destroy();
    // Only traced, under the popup's surface, as the window's is.
    if let Some(manager) = &client.globals.fractional_scale {
        manager.get_fractional_scale(&surface, handle, PopupScale(surface.id()));
    }
    // Grab before the first commit, as xdg-shell requires. The serial
    // should be the press that opened the menu; there is none, and a
    // compositor that validated it would dismiss the popup.
    if client.popup_grab {
        if let Some(seat) = &client.globals.seat {
            popup.grab(seat, 0);
            crate::say!(popup.id(), "grab()");
        }
    }
    // Traced with its surface, which input events name.
    crate::say!(popup.id(), "opened({})", surface.id());
    surface.commit();
    client.popups.push(Popup {
        surface,
        xdg,
        popup,
        configured: (width, height),
        drawn_at: None,
        drawn: Vec::new(),
    });
}

/// Draw the popup `xdg` is at the size it was configured to, unless it has
/// drawn at that size already, or exit with the error. A
/// `--repositioned-popup` moves once it has drawn.
fn draw_popup_or_stop(
    client: &mut Client,
    handle: &QueueHandle<Client>,
    xdg: &xdg_surface::XdgSurface,
) {
    let shm = client
        .globals
        .shm
        .as_ref()
        .expect("open() refuses a compositor without wl_shm");
    let popup = client
        .popups
        .iter_mut()
        .find(|popup| popup.xdg == *xdg)
        .expect("only a popup this client opened is configured");
    if popup.drawn_at == Some(popup.configured) {
        return;
    }
    let (width, height) = popup.configured;
    let (buffer, file) = solid_or_stop(shm, handle, (width, height), PopupRole);
    popup.surface.attach(Some(&buffer), 0, 0);
    popup.surface.damage(0, 0, width, height);
    popup.surface.commit();
    popup.drawn_at = Some(popup.configured);
    popup.drawn.push((buffer, file));
    if client.repositions {
        client.repositions = false;
        let wm_base = client
            .globals
            .wm_base
            .as_ref()
            .expect("open() refuses a compositor without xdg_wm_base");
        let positioner = positioner(wm_base, handle, POPUP_MOVED, false);
        popup.popup.reposition(&positioner, 1);
        positioner.destroy();
        crate::say!(popup.popup.id(), "reposition()");
    }
}

/// A positioner for a `(x, y, width, height)` popup with its corner at
/// `(x, y)` of its parent, sliding on both axes if `slides`.
fn positioner(
    wm_base: &xdg_wm_base::XdgWmBase,
    handle: &QueueHandle<Client>,
    (x, y, width, height): (i32, i32, i32, i32),
    slides: bool,
) -> xdg_positioner::XdgPositioner {
    let positioner = wm_base.create_positioner(handle, ());
    positioner.set_size(width, height);
    positioner.set_anchor_rect(x, y, 1, 1);
    positioner.set_anchor(xdg_positioner::Anchor::TopLeft);
    positioner.set_gravity(xdg_positioner::Gravity::BottomRight);
    if slides {
        positioner.set_constraint_adjustment(
            xdg_positioner::ConstraintAdjustment::SlideX
                | xdg_positioner::ConstraintAdjustment::SlideY,
        );
    }
    positioner
}

/// A buffer of `size` filled with [`POPUP_COLOR`], or exit with the error.
///
/// Returns its backing file too, which must outlive the buffer.
fn solid_or_stop<Role: Send + Sync + 'static>(
    shm: &wl_shm::WlShm,
    handle: &QueueHandle<Client>,
    (width, height): (i32, i32),
    role: Role,
) -> (wl_buffer::WlBuffer, std::fs::File)
where
    Client: Dispatch<wl_buffer::WlBuffer, Role>,
{
    let bytes = (width * height * 4) as usize;
    let pixels: Vec<u8> = POPUP_COLOR
        .to_ne_bytes()
        .iter()
        .copied()
        .cycle()
        .take(bytes)
        .collect();
    let file = anonymous(bytes).and_then(|file| file.write_all_at(&pixels, 0).map(|()| file));
    let file = match file {
        Ok(file) => file,
        Err(err) => {
            eprintln!("domicile-test-client: could not draw the popup: {err}");
            std::process::exit(1);
        }
    };
    let pool = shm.create_pool(file.as_fd(), bytes as i32, handle, ());
    let buffer = pool.create_buffer(0, width, height, width * 4, shm_format(false), handle, role);
    pool.destroy();
    (buffer, file)
}

/// Open the `--dialog`, once, with a first commit carrying no buffer.
fn open_dialog(client: &mut Client, handle: &QueueHandle<Client>) {
    if !client.wants_dialog {
        return;
    }
    client.wants_dialog = false;
    let (Some(compositor), Some(wm_base)) = (
        client.globals.compositor.as_ref(),
        client.globals.wm_base.as_ref(),
    ) else {
        unreachable!("open() refuses a compositor without these");
    };
    let surface = compositor.create_surface(handle, DialogRole);
    let xdg = wm_base.get_xdg_surface(&surface, handle, DialogRole);
    let toplevel = xdg.get_toplevel(handle, DialogRole);
    toplevel.set_title(format!("{} dialog", client.title));
    crate::say!(toplevel.id(), "opened({})", surface.id());
    surface.commit();
    client.dialog = Some(Dialog {
        surface,
        toplevel,
        drawn: None,
    });
}

/// Draw the `--dialog`'s single frame, then make it the window's dialog, or
/// exit with the error.
///
/// The parent follows the frame so the compositor hears of it after it has
/// announced the dialog.
fn draw_dialog_or_stop(client: &mut Client, handle: &QueueHandle<Client>) {
    let shm = client
        .globals
        .shm
        .as_ref()
        .expect("open() refuses a compositor without wl_shm");
    let window = client
        .window
        .as_ref()
        .expect("a dialog opens once the window is mapped");
    let dialog = client
        .dialog
        .as_mut()
        .expect("only a dialog this client opened is configured");
    if dialog.drawn.is_some() {
        return;
    }
    let (_, _, width, height) = POPUP;
    let (buffer, file) = solid_or_stop(shm, handle, (width, height), DialogRole);
    dialog.surface.attach(Some(&buffer), 0, 0);
    dialog.surface.damage(0, 0, width, height);
    dialog.surface.commit();
    dialog.drawn = Some((buffer, file));
    dialog.toplevel.set_parent(Some(&window.toplevel));
    crate::say!(dialog.toplevel.id(), "set_parent({})", window.toplevel.id());
}

/// Open the `--bubble` or `--scrolling-bubble` over the window, once.
///
/// A `--bubble` is as Chromium draws one: a desync subsurface of the window,
/// positioned, then drawn. It grows on its first frame; see [`grow_bubble`].
///
/// A `--scrolling-bubble` is sync, so its content shows with the window's
/// next commit, which moves it to that frame's stripe.
fn open_bubble(client: &mut Client, handle: &QueueHandle<Client>) {
    if !client.wants_bubble {
        return;
    }
    client.wants_bubble = false;
    let (Some(compositor), Some(window)) =
        (client.globals.compositor.as_ref(), client.window.as_ref())
    else {
        unreachable!("open() refuses a compositor without these, and made the window");
    };
    let subcompositor = client
        .globals
        .subcompositor
        .as_ref()
        .expect("--bubble needs a compositor that advertises wl_subcompositor");
    let surface = compositor.create_surface(handle, BubbleRole);
    if client.bubble_without_input {
        let nothing = compositor.create_region(handle, ());
        surface.set_input_region(Some(&nothing));
        nothing.destroy();
    }
    let subsurface = subcompositor.get_subsurface(&surface, &window.surface, handle, ());
    if client.scrolls {
        subsurface.set_sync();
    } else {
        subsurface.set_desync();
    }
    // Traced with its surface, which input events name.
    crate::say!(subsurface.id(), "opened({})", surface.id());
    client.bubble = Some(Bubble {
        surface,
        subsurface: Some(subsurface),
        drawn: Vec::new(),
    });
    let placed = if client.scrolls {
        let (x, width, height) = SCROLLING_BUBBLE;
        (x, scrolled_to(client.frame), width, height)
    } else {
        BUBBLE
    };
    draw_bubble(client, handle, placed);
}

/// Grow a `--bubble` after its first frame, once. A `--scrolling-bubble`
/// keeps its size.
fn grow_bubble(client: &mut Client, handle: &QueueHandle<Client>) {
    let grown_already = client
        .bubble
        .as_ref()
        .is_some_and(|bubble| bubble.drawn.len() > 1);
    if !grown_already && !client.scrolls {
        draw_bubble(client, handle, BUBBLE_GROWN);
    }
}

/// Place and draw the bubble at `(x, y, width, height)`.
///
/// The position applies on the window's next commit, which comes with its
/// next frame.
fn draw_bubble(
    client: &mut Client,
    handle: &QueueHandle<Client>,
    (x, y, width, height): (i32, i32, i32, i32),
) {
    let shm = client
        .globals
        .shm
        .as_ref()
        .expect("open() refuses a compositor without wl_shm");
    let bubble = client
        .bubble
        .as_mut()
        .expect("only a bubble this client opened is drawn");
    let (buffer, file) = solid_or_stop(shm, handle, (width, height), BubbleRole);
    if let Some(subsurface) = &bubble.subsurface {
        subsurface.set_position(x, y);
    }
    bubble.surface.attach(Some(&buffer), 0, 0);
    bubble.surface.damage(0, 0, width, height);
    bubble.surface.frame(handle, BubbleRole);
    bubble.surface.commit();
    bubble.drawn.push((buffer, file));
}

/// Hide the bubble as Chromium does: destroy its `wl_subsurface` and keep
/// the surface.
fn hide_bubble(client: &mut Client) {
    let subsurface = client
        .bubble
        .as_mut()
        .and_then(|bubble| bubble.subsurface.take());
    if let Some(subsurface) = subsurface {
        crate::say!(subsurface.id(), "hid()");
        subsurface.destroy();
    }
}

/// Draw a frame, or exit with the error.
///
/// Callers are event handlers and cannot return a `Result`. A failed draw has
/// skipped its frame request, so continuing would leave a process that never
/// draws again.
fn draw_or_stop(client: &mut Client, handle: &QueueHandle<Client>) {
    // A frame callback requested before the toplevel was destroyed can still
    // arrive.
    if !client.window_is_gone {
        if let Err(err) = client.draw(handle) {
            eprintln!("domicile-test-client: {err}");
            std::process::exit(1);
        }
    }
}

/// Rescale, or exit with the error.
///
/// Exits for the reason [`draw_or_stop`] does: without buffers the window
/// would stop redrawing.
fn follow_or_stop(client: &mut Client, handle: &QueueHandle<Client>) {
    if let Err(err) = client.follow(handle) {
        eprintln!("domicile-test-client: {err}");
        std::process::exit(1);
    }
}

/// Apply a configured size, or exit with the error.
///
/// Returns whether the size changed, so the caller knows to draw.
fn resize_or_stop(client: &mut Client, handle: &QueueHandle<Client>) -> bool {
    match client.resize(handle) {
        Ok(resized) => resized,
        Err(err) => {
            eprintln!("domicile-test-client: {err}");
            std::process::exit(1);
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Client {
    fn event(
        client: &mut Client,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                crate::say!(
                    registry.id(),
                    "global({}, \"{}\", {})",
                    name,
                    interface,
                    version
                );
                // Outputs are bound as they are announced, because displays
                // can be added after startup. Version 4 for `wl_output.name`,
                // which `both_configured_displays_are_advertised_to_a_client`
                // needs.
                if interface == "wl_output" {
                    let output: wl_output::WlOutput =
                        registry.bind(name, version.min(4), handle, ());
                    client.outputs.push((name, output));
                }
                client.globals.named.push((name, interface, version));
            }
            wl_registry::Event::GlobalRemove { name } => {
                // The compositor sends no `wl_surface.leave` for a removed
                // output, so drop its state here and rescale.
                client.globals.named.retain(|(named, _, _)| named != &name);
                let Some(at) = client.outputs.iter().position(|(named, _)| named == &name) else {
                    return;
                };
                let gone = client.outputs.remove(at).1.id();
                client.scales.retain(|(id, _)| id != &gone);
                client.entered.retain(|id| id != &gone);
                follow_or_stop(client, handle);
            }
            _ => {}
        }
    }
}

impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Client {
    fn event(
        _: &mut Client,
        wm_base: &xdg_wm_base::XdgWmBase,
        event: xdg_wm_base::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        // A client that does not answer pings is killed.
        if let xdg_wm_base::Event::Ping { serial } = event {
            wm_base.pong(serial);
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, ()> for Client {
    fn event(
        client: &mut Client,
        xdg: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg.ack_configure(serial);
            // Apply any size from the preceding `xdg_toplevel.configure`;
            // see [`Client::configured_size`].
            let resized = resize_or_stop(client, handle);
            // Draw on the first configure, which maps the window, and after a
            // resize, which replaced the buffers and lost the pending frame
            // callback. Other configures are only acknowledged.
            if !client.configured || resized {
                client.configured = true;
                draw_or_stop(client, handle);
                // After mapping, since activation names a surface.
                ask_for_focus_or_stop(client, handle, AskForFocus::OnceMapped, None);
                ring_the_bell(client);
                // A popup needs a mapped parent.
                open_popup(client, handle);
                open_bubble(client, handle);
                open_dialog(client, handle);
            }
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, PopupRole> for Client {
    fn event(
        client: &mut Client,
        xdg: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &PopupRole,
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg.ack_configure(serial);
            draw_popup_or_stop(client, handle, xdg);
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, DialogRole> for Client {
    fn event(
        client: &mut Client,
        xdg: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &DialogRole,
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg.ack_configure(serial);
            draw_dialog_or_stop(client, handle);
        }
    }
}

// The dialog keeps its size and is never closed by a check.
impl Dispatch<xdg_toplevel::XdgToplevel, DialogRole> for Client {
    fn event(
        _: &mut Client,
        _: &xdg_toplevel::XdgToplevel,
        _: xdg_toplevel::Event,
        _: &DialogRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

// Dialog surface and buffer events are ignored, as a popup's are.
impl Dispatch<wl_surface::WlSurface, DialogRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_surface::WlSurface,
        _: wl_surface::Event,
        _: &DialogRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

impl Dispatch<wl_buffer::WlBuffer, DialogRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_buffer::WlBuffer,
        _: wl_buffer::Event,
        _: &DialogRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

impl Dispatch<xdg_popup::XdgPopup, PopupRole> for Client {
    fn event(
        client: &mut Client,
        popup: &xdg_popup::XdgPopup,
        event: xdg_popup::Event,
        _: &PopupRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            // The popup's position relative to the window.
            xdg_popup::Event::Configure {
                x,
                y,
                width,
                height,
            } => {
                crate::say!(popup.id(), "configure({x}, {y}, {width}, {height})");
                client
                    .popups
                    .iter_mut()
                    .find(|open| open.popup == *popup)
                    .expect("only a popup this client has open is configured")
                    .configured = (width, height);
            }
            // Destroy a dismissed popup, as toolkits do.
            xdg_popup::Event::PopupDone => {
                crate::say!(popup.id(), "popup_done()");
                let at = client
                    .popups
                    .iter()
                    .position(|open| open.popup == *popup)
                    .expect("only a popup this client has open is dismissed");
                let open = client.popups.remove(at);
                open.popup.destroy();
                open.xdg.destroy();
                open.surface.destroy();
            }
            _ => {}
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Client {
    fn event(
        client: &mut Client,
        toplevel: &xdg_toplevel::XdgToplevel,
        event: xdg_toplevel::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        // Traced even when not followed, so checks can tell "no configure"
        // from "configure ignored".
        if let xdg_toplevel::Event::Configure {
            width,
            height,
            ref states,
        } = event
        {
            crate::say!(toplevel.id(), "configure({}, {})", width, height);
            // Trace activation on every configure. Chromium treats it as page
            // focus; without it, a page ignores Backspace and shortcuts.
            let activated =
                states.as_chunks::<4>().0.iter().any(|state| {
                    u32::from_ne_bytes(*state) == xdg_toplevel::State::Activated as u32
                });
            crate::say!(toplevel.id(), "activated({activated})");
            // Traced on every configure, so a check can tell "never
            // suspended" from "suspended and then resumed".
            let suspended =
                states.as_chunks::<4>().0.iter().any(|state| {
                    u32::from_ne_bytes(*state) == xdg_toplevel::State::Suspended as u32
                });
            crate::say!(toplevel.id(), "suspended({suspended})");
            // The states a shell sets, in protocol order.
            let set: Vec<&str> = [
                (xdg_toplevel::State::TiledLeft, "tiled_left"),
                (xdg_toplevel::State::TiledRight, "tiled_right"),
                (xdg_toplevel::State::TiledTop, "tiled_top"),
                (xdg_toplevel::State::TiledBottom, "tiled_bottom"),
                (xdg_toplevel::State::Maximized, "maximized"),
                (xdg_toplevel::State::Fullscreen, "fullscreen"),
                (xdg_toplevel::State::Resizing, "resizing"),
            ]
            .into_iter()
            .filter(|(state, _)| {
                states
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|held| u32::from_ne_bytes(*held) == *state as u32)
            })
            .map(|(_, name)| name)
            .collect();
            crate::say!(toplevel.id(), "states({})", set.join(" "));
            // On the first configure, so the window has been configured once
            // and the request needs a configure of its own.
            if let Some(ask_to) = client.ask_to.take() {
                ask(client, toplevel, ask_to);
            }
            // Zero means "client chooses". Negative is invalid and would cast
            // to a huge `u32`.
            if client.follow_configure && width > 0 && height > 0 {
                client.configured_size = Some((width as u32, height as u32));
            }
        }
        // Exit 0 on close, which
        // `a_close_from_the_chrome_reaches_the_client_and_comes_back`
        // (`domicile-compositor/tests/apps.rs`) waits for. Zero is the only
        // success exit, so it means the close was handled.
        if let xdg_toplevel::Event::Close = event {
            // Under `--outlive-its-window`, destroy only the toplevel and keep
            // the connection.
            if client.outlive_its_window {
                crate::say!(toplevel.id(), "destroy()");
                toplevel.destroy();
                client.window_is_gone = true;
            } else {
                std::process::exit(0);
            }
        }
    }
}

/// Make `--ask-to`'s request. Fullscreen names the first output bound.
fn ask(client: &Client, toplevel: &xdg_toplevel::XdgToplevel, ask_to: AskTo) {
    match ask_to {
        AskTo::Maximize => {
            toplevel.set_maximized();
            crate::say!(toplevel.id(), "set_maximized()");
        }
        AskTo::Unmaximize => {
            toplevel.unset_maximized();
            crate::say!(toplevel.id(), "unset_maximized()");
        }
        AskTo::Fullscreen => {
            let output = client.outputs.first().map(|(_, output)| output);
            toplevel.set_fullscreen(output);
            crate::say!(
                toplevel.id(),
                "set_fullscreen({})",
                output.map_or("nil".to_string(), |output| output.id().to_string())
            );
        }
        AskTo::Unfullscreen => {
            toplevel.unset_fullscreen();
            crate::say!(toplevel.id(), "unset_fullscreen()");
        }
        AskTo::Minimize => {
            toplevel.set_minimized();
            crate::say!(toplevel.id(), "set_minimized()");
        }
    }
}

impl Dispatch<wl_callback::WlCallback, ()> for Client {
    fn event(
        client: &mut Client,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        if let wl_callback::Event::Done { .. } = event {
            // The first frame is up. `--viewport-to` resizes it without a
            // buffer, and drawing stops so no later buffer resizes it instead.
            if let Some((width, height)) = client.viewport_to.take() {
                let window = client
                    .window
                    .as_ref()
                    .expect("open() runs before anything that could draw");
                let viewport = client
                    .viewport
                    .as_ref()
                    .expect("open() makes a viewport for --viewport-to");
                viewport.set_destination(width as i32, height as i32);
                crate::say!(viewport.id(), "set_destination({}, {})", width, height);
                window.surface.commit();
                return;
            }
            // `--resize-to` changes a shown window.
            if let Some(size) = client.resize_to.take() {
                client.configured_size = Some(size);
                resize_or_stop(client, handle);
            }
            draw_or_stop(client, handle);
        }
    }
}

/// The compositor has handled a copy's `set_selection` requests.
impl Dispatch<wl_callback::WlCallback, CopyRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        _: &CopyRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let wl_callback::Event::Done { .. } = event {
            crate::trace::say(format_args!("copy handled"));
        }
    }
}

/// The compositor has handled an insisting ask for client-side decorations.
impl Dispatch<wl_callback::WlCallback, InsistRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        _: &InsistRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let wl_callback::Event::Done { .. } = event {
            crate::trace::say(format_args!("insisted on drawing its own frame"));
        }
    }
}

impl Dispatch<wl_buffer::WlBuffer, usize> for Client {
    fn event(
        client: &mut Client,
        buffer: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        index: &usize,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        // Without releases the client runs out of buffers after two frames.
        if let wl_buffer::Event::Release = event {
            crate::say!(buffer.id(), "release()");
            let window = client
                .window
                .as_mut()
                .expect("a buffer was cut from this window's pool");
            // Compare the buffer, not just the index: after a rescale, a
            // release for a destroyed buffer can still arrive and would mark
            // a held buffer in the new pool as free.
            //
            // Compare `ObjectId`s, not wire numbers: destroyed buffers' wire
            // numbers are reused by later pools, but `ObjectId` equality also
            // checks a generation serial.
            if window.pixels.buffers[*index].id() == buffer.id() {
                window.pixels.held[*index] = false;
            }
        }
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for Client {
    fn event(
        client: &mut Client,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        // Binding the keyboard and pointer makes the compositor send input.
        // Checks read the trace, not the input itself.
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(capabilities),
        } = event
        {
            if capabilities.contains(wl_seat::Capability::Keyboard) {
                seat.get_keyboard(handle, ());
            }
            if capabilities.contains(wl_seat::Capability::Touch) && !client.no_touch {
                seat.get_touch(handle, ());
            }
            if capabilities.contains(wl_seat::Capability::Pointer) {
                let pointer = seat.get_pointer(handle, ());
                if let Some(manager) = &client.globals.gestures {
                    manager.get_pinch_gesture(&pointer, handle, ());
                    manager.get_swipe_gesture(&pointer, handle, ());
                    if manager.version() >= 3 {
                        manager.get_hold_gesture(&pointer, handle, ());
                    }
                }
                if let Some(manager) = &client.globals.relative {
                    manager.get_relative_pointer(&pointer, handle, ());
                }
                // Created now, because `set_shape` on pointer enter needs the
                // device to exist.
                client.cursor = client
                    .globals
                    .cursor
                    .as_ref()
                    .map(|manager| manager.get_pointer(&pointer, handle, ()));
            }
        }
    }
}

/// Activates the surface with the token the compositor returned.
///
/// The surface is the token's user data, so concurrent requests need no
/// shared state.
impl Dispatch<xdg_activation_token_v1::XdgActivationTokenV1, wl_surface::WlSurface> for Client {
    fn event(
        client: &mut Client,
        token: &xdg_activation_token_v1::XdgActivationTokenV1,
        event: xdg_activation_token_v1::Event,
        surface: &wl_surface::WlSurface,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let xdg_activation_token_v1::Event::Done { token: minted } = event {
            crate::say!(token.id(), "done(\"{minted}\")");
            // A token is single-use.
            token.destroy();
            if let Some(activation) = client.globals.activation.as_ref() {
                activation.activate(minted, surface);
                crate::say!(activation.id(), "activate()");
            }
        }
    }
}

/// Pastes each clipboard selection when `--paste` is given.
///
/// `selection` events go only to the focused client. `None` means the
/// selection was cleared.
impl Dispatch<wl_data_device::WlDataDevice, ()> for Client {
    fn event(
        client: &mut Client,
        _: &wl_data_device::WlDataDevice,
        event: wl_data_device::Event,
        (): &(),
        connection: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            wl_data_device::Event::Selection { id: Some(offer) } if client.paste => {
                paste("clipboard", connection, |fd| {
                    offer.receive(TEXT_MIME.to_string(), fd);
                });
            }
            // Drag-and-drop events; unused.
            _ => {}
        }
    }

    event_created_child!(Client, wl_data_device::WlDataDevice, [
        wl_data_device::EVT_DATA_OFFER_OPCODE => (wl_data_offer::WlDataOffer, ()),
    ]);
}

/// Pastes each primary selection when `--paste` is given.
///
/// A separate device and offer from the clipboard, which `tests/selection.rs`
/// relies on to show the two selections are kept apart.
impl Dispatch<zwp_primary_selection_device_v1::ZwpPrimarySelectionDeviceV1, ()> for Client {
    fn event(
        client: &mut Client,
        _: &zwp_primary_selection_device_v1::ZwpPrimarySelectionDeviceV1,
        event: zwp_primary_selection_device_v1::Event,
        (): &(),
        connection: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            zwp_primary_selection_device_v1::Event::Selection { id: Some(offer) }
                if client.paste =>
            {
                paste("primary", connection, |fd| {
                    offer.receive(TEXT_MIME.to_string(), fd);
                });
            }
            _ => {}
        }
    }

    event_created_child!(Client, zwp_primary_selection_device_v1::ZwpPrimarySelectionDeviceV1, [
        zwp_primary_selection_device_v1::EVT_DATA_OFFER_OPCODE
            => (zwp_primary_selection_offer_v1::ZwpPrimarySelectionOfferV1, ()),
    ]);
}

/// Serves pastes of the clipboard text.
impl Dispatch<wl_data_source::WlDataSource, ()> for Client {
    fn event(
        client: &mut Client,
        _: &wl_data_source::WlDataSource,
        event: wl_data_source::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        // Other events concern drag-and-drop or losing the selection.
        if let wl_data_source::Event::Send { mime_type, fd } = event {
            let copy = client
                .copy
                .as_ref()
                .expect("nothing makes a source without something to copy");
            serve(&mime_type, fd, copy);
        }
    }
}

/// Serves pastes of the primary selection text.
impl Dispatch<zwp_primary_selection_source_v1::ZwpPrimarySelectionSourceV1, ()> for Client {
    fn event(
        client: &mut Client,
        _: &zwp_primary_selection_source_v1::ZwpPrimarySelectionSourceV1,
        event: zwp_primary_selection_source_v1::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        // The other event means the selection was lost.
        if let zwp_primary_selection_source_v1::Event::Send { mime_type, fd } = event {
            let copy = client
                .copy_primary
                .as_ref()
                .expect("nothing makes a source without something to copy");
            serve(&mime_type, fd, copy);
        }
    }
}

/// Read an offered selection and trace it.
///
/// The offering client writes to the descriptor and closes it to mark the end.
/// A `std` socket pair stands in for a pipe.
///
/// The flush and the drop are both required: `receive` is only queued until
/// flushed, and the read ends at EOF only once every write end is closed,
/// including this process's copy.
fn paste(what: &str, connection: &Connection, receive: impl FnOnce(BorrowedFd<'_>)) {
    let (mut ours, theirs) =
        UnixStream::pair().expect("a socket pair is two descriptors and no policy");
    receive(theirs.as_fd());
    connection
        .flush()
        .expect("the compositor is still there; this client is talking to it");
    drop(theirs);
    ours.set_read_timeout(Some(PASTE_PATIENCE))
        .expect("a deadline a socket accepts");
    let mut said = String::new();
    ours.read_to_string(&mut said)
        .expect("the client that offered the selection wrote it within the deadline");
    crate::trace::say(format_args!("{what}: {said}"));
}

/// Write the copied text to a paste's descriptor.
///
/// Dropping the descriptor closes it, which tells the reader the data is
/// complete.
fn serve(mime_type: &str, fd: OwnedFd, copy: &str) {
    assert_eq!(
        mime_type, TEXT_MIME,
        "nothing else was offered, so nothing else can be asked for",
    );
    std::fs::File::from(fd)
        .write_all(copy.as_bytes())
        .expect("the descriptor a paste handed over takes what was copied");
}

delegate_noop!(Client: ignore xdg_activation_v1::XdgActivationV1);
delegate_noop!(Client: ignore zwp_text_input_manager_v3::ZwpTextInputManagerV3);

/// Traces what an input method sends the editor of `--text-input`, and
/// enables it on each enter, as an editor with a focused field does. Its text
/// cursor starts at [`CARET`] and moves [`CARET_ADVANCE`] right for each
/// character committed, traced as `cursor_rectangle(x, y, width, height)`.
impl Dispatch<zwp_text_input_v3::ZwpTextInputV3, ()> for Client {
    fn event(
        client: &mut Client,
        text_input: &zwp_text_input_v3::ZwpTextInputV3,
        event: zwp_text_input_v3::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            zwp_text_input_v3::Event::Enter { surface } => {
                crate::say!(text_input.id(), "text_input_enter({})", surface.id());
                text_input.enable();
                text_input.set_surrounding_text(
                    SURROUNDING_TEXT.to_string(),
                    SURROUNDING_TEXT.len() as i32,
                    SURROUNDING_TEXT.len() as i32,
                );
                client.place_the_caret(text_input);
                text_input.commit();
            }
            zwp_text_input_v3::Event::Leave { surface } => {
                crate::say!(text_input.id(), "text_input_leave({})", surface.id());
                text_input.disable();
                text_input.commit();
            }
            zwp_text_input_v3::Event::PreeditString {
                text,
                cursor_begin,
                cursor_end,
            } => {
                crate::say!(
                    text_input.id(),
                    "preedit({:?}, {}, {})",
                    text.unwrap_or_default(),
                    cursor_begin,
                    cursor_end
                );
            }
            zwp_text_input_v3::Event::CommitString { text } => {
                let text = text.unwrap_or_default();
                crate::say!(text_input.id(), "commit_string({:?})", text);
                let typed = i32::try_from(text.chars().count()).unwrap_or(i32::MAX);
                client.caret_x = client
                    .caret_x
                    .saturating_add(typed.saturating_mul(CARET_ADVANCE));
                client.place_the_caret(text_input);
                text_input.commit();
            }
            zwp_text_input_v3::Event::DeleteSurroundingText {
                before_length,
                after_length,
            } => {
                crate::say!(
                    text_input.id(),
                    "delete_surrounding({}, {})",
                    before_length,
                    after_length
                );
            }
            zwp_text_input_v3::Event::Done { serial } => {
                crate::say!(text_input.id(), "text_input_done({})", serial);
            }
            _ => {}
        }
    }
}

/// The text before the cursor of `--text-input`'s field, which an input
/// method reads as `surrounding_text`.
pub const SURROUNDING_TEXT: &str = "typed so far";

/// Where `--text-input`'s text cursor starts on its surface, and its size:
/// `x, y, width, height`, logical.
pub const CARET: (i32, i32, i32, i32) = (40, 30, 2, 18);

/// How far `--text-input`'s text cursor moves for each character committed.
pub const CARET_ADVANCE: i32 = 8;

impl Client {
    /// Tell the compositor where `--text-input`'s text cursor is. Sent with
    /// the caller's next commit.
    fn place_the_caret(&self, text_input: &zwp_text_input_v3::ZwpTextInputV3) {
        let (_, y, width, height) = CARET;
        text_input.set_cursor_rectangle(self.caret_x, y, width, height);
        crate::say!(
            text_input.id(),
            "cursor_rectangle({}, {}, {}, {})",
            self.caret_x,
            y,
            width,
            height
        );
    }
}
delegate_noop!(Client: ignore xdg_system_bell_v1::XdgSystemBellV1);
delegate_noop!(Client: ignore zxdg_decoration_manager_v1::ZxdgDecorationManagerV1);
delegate_noop!(Client: ignore org_kde_kwin_server_decoration_manager::OrgKdeKwinServerDecorationManager);
delegate_noop!(Client: ignore wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1);
delegate_noop!(Client: ignore wp_viewporter::WpViewporter);
delegate_noop!(Client: ignore wl_region::WlRegion);
delegate_noop!(Client: ignore wp_viewport::WpViewport);
delegate_noop!(Client: ignore zxdg_exporter_v1::ZxdgExporterV1);
delegate_noop!(Client: ignore domicile_anchor_manager_v1::DomicileAnchorManagerV1);
delegate_noop!(Client: ignore domicile_toplevel_anchor_v1::DomicileToplevelAnchorV1);
delegate_noop!(Client: ignore zxdg_exporter_v2::ZxdgExporterV2);

/// Traces the preferred scale in the protocol's 120ths, so 1.2 reads
/// `preferred_scale(144)`.
impl Dispatch<wp_fractional_scale_v1::WpFractionalScaleV1, ()> for Client {
    fn event(
        _: &mut Client,
        fractional: &wp_fractional_scale_v1::WpFractionalScaleV1,
        event: wp_fractional_scale_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = event {
            crate::say!(fractional.id(), "preferred_scale({scale})");
        }
    }
}

/// Traces the xdg decoration mode by name, since the two decoration protocols
/// number modes differently.
impl Dispatch<zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1, ()> for Client {
    fn event(
        _: &mut Client,
        decoration: &zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1,
        event: zxdg_toplevel_decoration_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let zxdg_toplevel_decoration_v1::Event::Configure { mode } = event {
            crate::say!(decoration.id(), "configure({})", named(mode));
        }
    }
}

impl Dispatch<zxdg_exported_v1::ZxdgExportedV1, ()> for Client {
    fn event(
        _: &mut Client,
        exported: &zxdg_exported_v1::ZxdgExportedV1,
        event: zxdg_exported_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let zxdg_exported_v1::Event::Handle { handle } = event {
            crate::say!(exported.id(), "handle(\"{handle}\")");
        }
    }
}

impl Dispatch<zxdg_exported_v2::ZxdgExportedV2, ()> for Client {
    fn event(
        _: &mut Client,
        exported: &zxdg_exported_v2::ZxdgExportedV2,
        event: zxdg_exported_v2::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let zxdg_exported_v2::Event::Handle { handle } = event {
            crate::say!(exported.id(), "handle(\"{handle}\")");
        }
    }
}

impl Dispatch<org_kde_kwin_server_decoration::OrgKdeKwinServerDecoration, ()> for Client {
    fn event(
        _: &mut Client,
        decoration: &org_kde_kwin_server_decoration::OrgKdeKwinServerDecoration,
        event: org_kde_kwin_server_decoration::Event,
        _: &(),
        connection: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        if let org_kde_kwin_server_decoration::Event::Mode { mode } = event {
            crate::say!(decoration.id(), "mode({})", named(mode));
            // Insist on client side, as GTK3 and Firefox do. The sync's
            // callback arrives after any answer to the ask.
            if mode == WEnum::Value(org_kde_kwin_server_decoration::Mode::Server) {
                decoration.request_mode(org_kde_kwin_server_decoration::Mode::Client);
                connection.display().sync(handle, InsistRole);
            }
        }
    }
}
delegate_noop!(Client: ignore zwp_idle_inhibit_manager_v1::ZwpIdleInhibitManagerV1);
delegate_noop!(Client: ignore zwp_idle_inhibitor_v1::ZwpIdleInhibitorV1);
delegate_noop!(Client: ignore zwp_keyboard_shortcuts_inhibit_manager_v1::ZwpKeyboardShortcutsInhibitManagerV1);

/// Traces whether the compositor honors the shortcuts inhibitor.
impl Dispatch<zwp_keyboard_shortcuts_inhibitor_v1::ZwpKeyboardShortcutsInhibitorV1, ()> for Client {
    fn event(
        _: &mut Client,
        inhibitor: &zwp_keyboard_shortcuts_inhibitor_v1::ZwpKeyboardShortcutsInhibitorV1,
        event: zwp_keyboard_shortcuts_inhibitor_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            zwp_keyboard_shortcuts_inhibitor_v1::Event::Active => {
                crate::say!(inhibitor.id(), "active");
            }
            zwp_keyboard_shortcuts_inhibitor_v1::Event::Inactive => {
                crate::say!(inhibitor.id(), "inactive");
            }
            _ => {}
        }
    }
}
delegate_noop!(Client: ignore wl_data_device_manager::WlDataDeviceManager);
delegate_noop!(Client: ignore wl_data_offer::WlDataOffer);
delegate_noop!(Client: ignore zwp_primary_selection_device_manager_v1::ZwpPrimarySelectionDeviceManagerV1);
delegate_noop!(Client: ignore zwp_primary_selection_offer_v1::ZwpPrimarySelectionOfferV1);
delegate_noop!(Client: ignore wl_compositor::WlCompositor);
delegate_noop!(Client: ignore wl_shm::WlShm);
delegate_noop!(Client: ignore wl_shm_pool::WlShmPool);
delegate_noop!(Client: ignore xdg_positioner::XdgPositioner);

// Popup surface and buffer events are ignored: it is drawn once, and the
// window reports outputs.
/// Traces the displays a popup enters and leaves, under its own surface.
impl Dispatch<wl_surface::WlSurface, PopupRole> for Client {
    fn event(
        _: &mut Client,
        surface: &wl_surface::WlSurface,
        event: wl_surface::Event,
        _: &PopupRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            wl_surface::Event::Enter { output } => {
                crate::say!(surface.id(), "enter({})", output.id());
            }
            wl_surface::Event::Leave { output } => {
                crate::say!(surface.id(), "leave({})", output.id());
            }
            _ => {}
        }
    }
}

/// User data for a popup's `wp_fractional_scale_v1`: the popup's surface,
/// which its preferred scale is traced under.
struct PopupScale(ObjectId);

/// Traces a popup's preferred scale as
/// `wl_surface@N.preferred_scale(120)`, so a check can tell it from the
/// window's.
impl Dispatch<wp_fractional_scale_v1::WpFractionalScaleV1, PopupScale> for Client {
    fn event(
        _: &mut Client,
        _: &wp_fractional_scale_v1::WpFractionalScaleV1,
        event: wp_fractional_scale_v1::Event,
        PopupScale(surface): &PopupScale,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = event {
            crate::say!(surface, "preferred_scale({scale})");
        }
    }
}

impl Dispatch<wl_buffer::WlBuffer, PopupRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_buffer::WlBuffer,
        _: wl_buffer::Event,
        _: &PopupRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}
delegate_noop!(Client: ignore wl_subcompositor::WlSubcompositor);
delegate_noop!(Client: ignore wl_subsurface::WlSubsurface);

// Cursor surface and buffer events are ignored, as a bubble's are.
impl Dispatch<wl_surface::WlSurface, CursorRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_surface::WlSurface,
        _: wl_surface::Event,
        _: &CursorRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

impl Dispatch<wl_buffer::WlBuffer, CursorRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_buffer::WlBuffer,
        _: wl_buffer::Event,
        _: &CursorRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

// Bubble surface and buffer events are ignored, as a popup's are.
impl Dispatch<wl_surface::WlSurface, BubbleRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_surface::WlSurface,
        _: wl_surface::Event,
        _: &BubbleRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

impl Dispatch<wl_buffer::WlBuffer, BubbleRole> for Client {
    fn event(
        _: &mut Client,
        _: &wl_buffer::WlBuffer,
        _: wl_buffer::Event,
        _: &BubbleRole,
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
    }
}

/// The bubble's first frame is done: grow it.
impl Dispatch<wl_callback::WlCallback, BubbleRole> for Client {
    fn event(
        client: &mut Client,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        _: &BubbleRole,
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        if let wl_callback::Event::Done { .. } = event {
            grow_bubble(client, handle);
        }
    }
}
delegate_noop!(Client: ignore wp_cursor_shape_manager_v1::WpCursorShapeManagerV1);
delegate_noop!(Client: ignore wp_cursor_shape_device_v1::WpCursorShapeDeviceV1);

/// Tracks which outputs the surface is on and rescales on each change.
impl Dispatch<wl_surface::WlSurface, ()> for Client {
    fn event(
        client: &mut Client,
        surface: &wl_surface::WlSurface,
        event: wl_surface::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        match event {
            wl_surface::Event::Enter { output } => {
                crate::say!(surface.id(), "enter({})", output.id());
                let on = output.id();
                if !client.entered.contains(&on) {
                    client.entered.push(on);
                }
            }
            wl_surface::Event::Leave { output } => {
                crate::say!(surface.id(), "leave({})", output.id());
                let off = output.id();
                client.entered.retain(|on| on != &off);
            }
            _ => return,
        }
        // The wanted scale depends on both the outputs entered and their
        // scales.
        follow_or_stop(client, handle);
    }
}

/// Traces output geometry, mode, name and scale, and records the scale.
///
/// `name` lets checks see which screen a window entered (see
/// `Client::on_screens` in the compositor's tests). Rescaling waits for `done`,
/// since the preceding events are parts of one update.
impl Dispatch<wl_output::WlOutput, ()> for Client {
    fn event(
        client: &mut Client,
        output: &wl_output::WlOutput,
        event: wl_output::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        match event {
            wl_output::Event::Geometry {
                x,
                y,
                physical_width,
                physical_height,
                subpixel,
                make,
                model,
                transform,
            } => {
                crate::say!(
                    output.id(),
                    "geometry({}, {}, {}, {}, {}, \"{}\", \"{}\", {})",
                    x,
                    y,
                    physical_width,
                    physical_height,
                    number(subpixel),
                    make,
                    model,
                    number(transform)
                );
            }
            wl_output::Event::Mode {
                flags,
                width,
                height,
                refresh,
            } => {
                crate::say!(
                    output.id(),
                    "mode({}, {}, {}, {})",
                    number(flags),
                    width,
                    height,
                    refresh
                );
            }
            wl_output::Event::Name { name } => {
                crate::say!(output.id(), "name(\"{}\")", name);
            }
            wl_output::Event::Scale { factor } => {
                crate::say!(output.id(), "scale({})", factor);
                let of = output.id();
                match client.scales.iter_mut().find(|(id, _)| id == &of) {
                    Some((_, scale)) => *scale = factor,
                    None => client.scales.push((of, factor)),
                }
            }
            wl_output::Event::Done => {
                crate::say!(output.id(), "done()");
                // Act once the update is complete.
                follow_or_stop(client, handle);
            }
            _ => {}
        }
    }
}

/// Traces keyboard events.
///
/// `modifiers` lets checks spot a lost key release that leaves a modifier
/// held. `keymap` is traced on each change, with how its fd was opened, so
/// checks can see a reloaded layout and a keymap a confined client could not
/// receive.
impl Dispatch<wl_keyboard::WlKeyboard, ()> for Client {
    fn event(
        client: &mut Client,
        keyboard: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        (): &(),
        connection: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        match event {
            // Copy on focus; see `Client::copy_what_was_asked_for`.
            wl_keyboard::Event::Enter {
                serial, surface, ..
            } => {
                // The window's surface, or a grabbing popup's.
                crate::say!(keyboard.id(), "enter({})", surface.id());
                client.entered_at = Some(serial);
                client.copy_what_was_asked_for(connection, handle);
                if let Some(summary) = client.notify.take() {
                    client.notified_on = Some(
                        crate::notification::notify(&summary)
                            .expect("the session bus takes a notification"),
                    );
                }
                ask_for_focus_or_stop(client, handle, AskForFocus::WhenEntered, Some(serial));
            }
            wl_keyboard::Event::Leave { .. } => {
                let entered_at = client.entered_at;
                ask_for_focus_or_stop(client, handle, AskForFocus::WhenLeft, entered_at);
            }
            wl_keyboard::Event::Key {
                serial,
                time,
                key,
                state,
            } => {
                crate::say!(
                    keyboard.id(),
                    "key({}, {}, {}, {})",
                    serial,
                    time,
                    key,
                    number(state)
                );
            }
            wl_keyboard::Event::Keymap { fd, size, .. } => {
                let access = access_mode(fd.as_fd());
                crate::say!(
                    keyboard.id(),
                    "keymap({}, {})",
                    layout_named_by(fd, size),
                    access
                );
            }
            wl_keyboard::Event::RepeatInfo { rate, delay } => {
                crate::say!(keyboard.id(), "repeat_info({}, {})", rate, delay);
            }
            wl_keyboard::Event::Modifiers {
                serial,
                mods_depressed,
                mods_latched,
                mods_locked,
                group,
            } => {
                crate::say!(
                    keyboard.id(),
                    "modifiers({}, {}, {}, {}, {})",
                    serial,
                    mods_depressed,
                    mods_latched,
                    mods_locked,
                    group
                );
            }
            _ => {}
        }
    }
}

/// Traces pointer events and sets the cursor shape.
impl Dispatch<wl_pointer::WlPointer, ()> for Client {
    fn event(
        client: &mut Client,
        pointer: &wl_pointer::WlPointer,
        event: wl_pointer::Event,
        (): &(),
        _: &Connection,
        handle: &QueueHandle<Client>,
    ) {
        match event {
            wl_pointer::Event::Enter {
                serial,
                surface,
                surface_x,
                surface_y,
            } => {
                crate::say!(
                    pointer.id(),
                    "enter({}, {}, {}, {})",
                    serial,
                    surface.id(),
                    surface_x,
                    surface_y
                );
                constrain_the_pointer(client, handle, pointer, &surface);
                client.pointer_over = Some(surface);
                if client.cursor_surface {
                    draw_the_cursor(client, handle, Some((pointer, serial)), (4, 4));
                } else {
                    // The cursor shape request is how the compositor learns
                    // which cursor to pass to the chrome.
                    client
                        .cursor
                        .as_ref()
                        .expect("the pointer that entered is the one the device names")
                        .set_shape(serial, wp_cursor_shape_device_v1::Shape::Default);
                }
            }
            wl_pointer::Event::Leave { serial, surface } => {
                crate::say!(pointer.id(), "leave({}, {})", serial, surface.id());
                client.pointer_over = None;
            }
            wl_pointer::Event::Motion {
                time,
                surface_x,
                surface_y,
            } => {
                crate::say!(
                    pointer.id(),
                    "motion({}, {}, {})",
                    time,
                    surface_x,
                    surface_y
                );
            }
            wl_pointer::Event::Button {
                serial,
                time,
                button,
                state,
            } => {
                crate::say!(
                    pointer.id(),
                    "button({}, {}, {}, {})",
                    serial,
                    time,
                    button,
                    number(state)
                );
                // A press on the bubble hides it, as choosing something in an
                // extension popup closes it.
                let on_the_bubble = client
                    .bubble
                    .as_ref()
                    .is_some_and(|bubble| client.pointer_over.as_ref() == Some(&bubble.surface));
                let pressed = state == WEnum::Value(wl_pointer::ButtonState::Pressed);
                if on_the_bubble && pressed {
                    hide_bubble(client);
                }
                if client.sliding_menu && pressed {
                    open_a_sliding_menu(client, handle);
                }
                if client.cursor_surface && pressed {
                    draw_the_cursor(client, handle, None, (6, 6));
                }
                if let Some(drag) = client
                    .ask_to_drag
                    .filter(|drag| pressed != (*drag == AskToDrag::MoveAfterRelease))
                {
                    ask_to_drag(client, drag, serial);
                }
            }
            wl_pointer::Event::Axis { time, axis, value } => {
                crate::say!(pointer.id(), "axis({}, {}, {})", time, number(axis), value);
            }
            wl_pointer::Event::AxisSource { axis_source } => {
                crate::say!(pointer.id(), "axis_source({})", number(axis_source));
            }
            wl_pointer::Event::AxisStop { time, axis } => {
                crate::say!(pointer.id(), "axis_stop({}, {})", time, number(axis));
            }
            wl_pointer::Event::AxisDiscrete { axis, discrete } => {
                crate::say!(
                    pointer.id(),
                    "axis_discrete({}, {})",
                    number(axis),
                    discrete
                );
            }
            wl_pointer::Event::Frame => {
                crate::say!(pointer.id(), "frame()");
            }
            _ => {}
        }
    }
}

/// An enum value's name, or its number when this client's protocol version
/// does not know it.
fn named<T: std::fmt::Debug>(stated: WEnum<T>) -> String {
    match stated {
        WEnum::Value(value) => format!("{value:?}"),
        WEnum::Unknown(raw) => raw.to_string(),
    }
}

/// An enum argument's wire value, which libwayland prints and checks match.
fn number<T: Into<u32>>(stated: WEnum<T>) -> u32 {
    match stated {
        WEnum::Value(known) => known.into(),
        WEnum::Unknown(raw) => raw,
    }
}

/// The name of the keymap's first group, such as `English (Dvorak)`.
///
/// The size includes the trailing NUL. An unreadable keymap is reported as
/// such, so a check fails with the reason instead of passing on a guess.
fn layout_named_by(fd: std::os::fd::OwnedFd, size: u32) -> String {
    let file = std::fs::File::from(fd);
    let mut text = vec![0u8; size as usize];
    if let Err(why) = file.read_exact_at(&mut text, 0) {
        return format!("unreadable: {why}");
    }
    let Ok(text) = String::from_utf8(text) else {
        return "not text".to_string();
    };
    first_group_name(&text).to_string()
}

/// How `fd` was opened: `read-only`, `write-only` or `read-write`, or why that
/// is unknown.
///
/// Read from `/proc/self/fdinfo`, whose `flags` are `F_GETFL`'s in octal.
/// SELinux refuses a confined client an fd opened for writing that it may not
/// write.
fn access_mode(fd: BorrowedFd) -> String {
    let info = match std::fs::read_to_string(format!("/proc/self/fdinfo/{}", fd.as_raw_fd())) {
        Ok(info) => info,
        Err(why) => return format!("unknown: {why}"),
    };
    let flags = info
        .lines()
        .find_map(|line| line.strip_prefix("flags:"))
        .and_then(|flags| u32::from_str_radix(flags.trim(), 8).ok());
    match flags.map(|flags| flags & 0o3) {
        None => "unknown: no flags in fdinfo".to_string(),
        Some(0) => "read-only".to_string(),
        Some(1) => "write-only".to_string(),
        Some(2) => "read-write".to_string(),
        Some(other) => format!("unknown: access mode {other}"),
    }
}

/// The first group name in a keymap's text, or why there is none.
///
/// The first `name[...]` in `xkb_symbols`. libxkbcommon 1.12 writes the group
/// as `1`, older versions as `Group1`.
fn first_group_name(text: &str) -> &str {
    let Some(symbols) = text.find("xkb_symbols") else {
        return "no xkb_symbols";
    };
    let Some(at) = text[symbols..].find("name[") else {
        return "no group name";
    };
    let rest = &text[symbols + at..];
    let Some(opens) = rest.find('"') else {
        return "an unopened group name";
    };
    let rest = &rest[opens + 1..];
    match rest.find('"') {
        None => "an unclosed group name",
        Some(ends) => &rest[..ends],
    }
}

#[cfg(test)]
mod tests {
    use wayland_client::protocol::wl_output::Transform;
    use wayland_client::protocol::wl_shm;

    use std::os::fd::AsFd as _;

    use super::{
        access_mode, buffer_size, deep_pixel, first_group_name, half_float, halves, scrolled_to,
        shm_format, striped, DeepFormat, COLORS, SCROLLING_BUBBLE, SCROLL_STEP, SIZE, STRIPE_COLOR,
        TRANSLUCENT_ALPHA, TRANSLUCENT_COLORS, TURNED_COLORS,
    };

    #[test]
    fn the_stripe_steps_down_the_window_and_starts_again_at_the_top() {
        let (_, _, height) = SCROLLING_BUBBLE;
        let tops: Vec<i32> = (0..60).map(scrolled_to).collect();
        assert_eq!(tops[..3], [0, SCROLL_STEP, 2 * SCROLL_STEP]);
        for (frame, pair) in tops.windows(2).enumerate() {
            assert!(
                pair[1] == pair[0] + SCROLL_STEP || pair[1] == 0,
                "frame {frame} to the next: {pair:?}"
            );
        }
        assert!(tops[1..].contains(&0), "it starts again at the top");
        assert!(
            tops.iter().all(|top| top + height <= SIZE.1 as i32),
            "the stripe stays inside the window: {tops:?}"
        );
    }

    #[test]
    fn a_striped_buffer_is_the_window_color_with_its_rows_in_the_stripe_color() {
        let pixel = |bytes: &[u8], at: usize| {
            u32::from_ne_bytes(bytes[at * 4..at * 4 + 4].try_into().unwrap())
        };
        let drawn = striped(2, 4, 1..3);
        assert_eq!(drawn.len(), 2 * 4 * 4);
        assert_eq!(
            (0..8).map(|at| pixel(&drawn, at)).collect::<Vec<_>>(),
            [
                COLORS[0],
                COLORS[0],
                STRIPE_COLOR,
                STRIPE_COLOR,
                STRIPE_COLOR,
                STRIPE_COLOR,
                COLORS[0],
                COLORS[0],
            ]
        );
    }

    #[test]
    fn an_fd_is_named_by_how_it_was_opened() {
        let read_only = std::fs::File::open(env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml")
            .expect("the manifest is there to open");
        assert_eq!(access_mode(read_only.as_fd()), "read-only");
        let (socket, _) = std::os::unix::net::UnixStream::pair().expect("a socket pair");
        assert_eq!(access_mode(socket.as_fd()), "read-write");
    }

    #[test]
    fn a_group_name_is_read_however_its_group_is_written() {
        // libxkbcommon 1.12 writes `name[1]` where older versions write
        // `name[Group1]`. A key type's `level_name` is not a group name.
        let types = "xkb_types {\n\ttype \"ONE\" {\n\t\tlevel_name[1]= \"Any\";\n\t};\n};\n";
        for group in ["Group1", "1"] {
            let symbols =
                format!("xkb_symbols \"pc\" {{\n\tname[{group}]=\"English (US)\";\n}};\n");
            assert_eq!(
                first_group_name(&format!("{types}{symbols}")),
                "English (US)",
                "written as name[{group}]"
            );
        }
    }

    #[test]
    fn a_buffer_drawn_on_its_side_is_the_window_on_its_side() {
        assert_eq!(buffer_size((320, 240), Some(Transform::_90)), (240, 320));
        assert_eq!(
            buffer_size((320, 240), Some(Transform::Flipped270)),
            (240, 320)
        );
        assert_eq!(buffer_size((320, 240), Some(Transform::_180)), (320, 240));
        assert_eq!(buffer_size((320, 240), None), (320, 240));
    }

    #[test]
    fn a_turned_buffer_is_one_color_on_the_left_and_the_other_on_the_right() {
        let pixel = |bytes: &[u8], at: usize| {
            u32::from_ne_bytes(bytes[at * 4..at * 4 + 4].try_into().unwrap())
        };
        let drawn = halves(4, 2);
        assert_eq!(drawn.len(), 4 * 2 * 4);
        // Row by row: two pixels of each color.
        assert_eq!(
            (0..8).map(|at| pixel(&drawn, at)).collect::<Vec<_>>(),
            [0, 0, 1, 1, 0, 0, 1, 1].map(|half| TURNED_COLORS[half])
        );
    }

    #[test]
    fn a_see_through_window_is_premultiplied_and_actually_see_through() {
        // `Argb8888` is premultiplied: no channel may exceed alpha.
        for (translucent, opaque) in TRANSLUCENT_COLORS.iter().zip(COLORS) {
            let [alpha, red, green, blue] = translucent.to_be_bytes();
            assert_eq!(alpha, TRANSLUCENT_ALPHA, "{translucent:#010x}");
            for (channel, of) in [red, green, blue]
                .iter()
                .zip(opaque.to_be_bytes().iter().skip(1))
            {
                assert!(
                    *channel <= alpha,
                    "{translucent:#010x}: {channel} over {alpha}",
                );
                // Each channel is the opaque color scaled by alpha.
                assert_eq!(
                    u32::from(*channel),
                    u32::from(*of) * u32::from(alpha) / 0xff,
                    "{translucent:#010x} against {opaque:#010x}",
                );
            }
        }
    }

    #[test]
    fn only_a_see_through_window_asks_for_a_format_with_alpha() {
        // `Xrgb8888` has no alpha, so only `--translucent` may use
        // `Argb8888`.
        assert_eq!(shm_format(true), wl_shm::Format::Argb8888);
        assert_eq!(shm_format(false), wl_shm::Format::Xrgb8888);
    }

    #[test]
    fn a_10_bit_pixel_is_red_in_its_lowest_bits() {
        let pixel = u32::from_le_bytes(
            deep_pixel(DeepFormat::Abgr2101010, 0x00_ff_00_00)
                .try_into()
                .unwrap(),
        );

        assert_eq!(pixel, (3 << 30) | 1023);
    }

    #[test]
    fn a_10_bit_pixel_without_alpha_leaves_its_padding_zero() {
        let pixel = u32::from_le_bytes(
            deep_pixel(DeepFormat::Xbgr2101010, 0x00_00_00_ff)
                .try_into()
                .unwrap(),
        );

        assert_eq!(pixel, 1023 << 20);
    }

    #[test]
    fn each_8_bit_channel_survives_10_bits() {
        for value in 0..=255u32 {
            let ten = u32::from_le_bytes(
                deep_pixel(DeepFormat::Xbgr2101010, value << 16)
                    .try_into()
                    .unwrap(),
            );
            assert_eq!((ten * 255 + 511) / 1023, value);
        }
    }

    #[test]
    fn a_half_float_pixel_is_red_alpha_last() {
        let pixel = u64::from_le_bytes(
            deep_pixel(DeepFormat::Abgr16161616f, 0x00_ff_00_00)
                .try_into()
                .unwrap(),
        );

        // 1.0 is 0x3c00.
        assert_eq!(pixel, (0x3c00 << 48) | 0x3c00);
    }

    #[test]
    fn half_floats_round_to_the_nearest() {
        assert_eq!(half_float(0.0), 0);
        assert_eq!(half_float(1.0), 0x3c00);
        assert_eq!(half_float(0.5), 0x3800);
        // 0x33 / 255 = 0.2, nearest half 0x3266.
        assert_eq!(half_float(0x33 as f32 / 255.0), 0x3266);
    }
}

impl Dispatch<wl_touch::WlTouch, ()> for Client {
    fn event(
        _: &mut Client,
        touch: &wl_touch::WlTouch,
        event: wl_touch::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        use wl_touch::Event;
        match event {
            Event::Down {
                time,
                surface,
                id,
                x,
                y,
                ..
            } => {
                crate::say!(touch.id(), "down({time}, {}, {id}, {x}, {y})", surface.id());
            }
            Event::Motion { time, id, x, y } => {
                crate::say!(touch.id(), "touch_motion({time}, {id}, {x}, {y})");
            }
            Event::Up { time, id, .. } => {
                crate::say!(touch.id(), "up({time}, {id})");
            }
            Event::Frame => crate::say!(touch.id(), "touch_frame()"),
            Event::Cancel => crate::say!(touch.id(), "cancel()"),
            _ => {}
        }
    }
}

impl Dispatch<zwp_pointer_gesture_pinch_v1::ZwpPointerGesturePinchV1, ()> for Client {
    fn event(
        _: &mut Client,
        gesture: &zwp_pointer_gesture_pinch_v1::ZwpPointerGesturePinchV1,
        event: zwp_pointer_gesture_pinch_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        use zwp_pointer_gesture_pinch_v1::Event;
        match event {
            Event::Begin { time, fingers, .. } => {
                crate::say!(gesture.id(), "pinch_begin({time}, {fingers})");
            }
            Event::Update {
                time,
                dx,
                dy,
                scale,
                rotation,
            } => {
                crate::say!(
                    gesture.id(),
                    "pinch_update({time}, {dx}, {dy}, {scale}, {rotation})"
                );
            }
            Event::End {
                time,
                cancelled: canceled,
                ..
            } => {
                crate::say!(gesture.id(), "pinch_end({time}, {canceled})");
            }
            _ => unreachable!("the pinch protocol has only begin, update and end"),
        }
    }
}

impl Dispatch<zwp_pointer_gesture_swipe_v1::ZwpPointerGestureSwipeV1, ()> for Client {
    fn event(
        _: &mut Client,
        gesture: &zwp_pointer_gesture_swipe_v1::ZwpPointerGestureSwipeV1,
        event: zwp_pointer_gesture_swipe_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        use zwp_pointer_gesture_swipe_v1::Event;
        match event {
            Event::Begin { time, fingers, .. } => {
                crate::say!(gesture.id(), "swipe_begin({time}, {fingers})");
            }
            Event::Update { time, dx, dy } => {
                crate::say!(gesture.id(), "swipe_update({time}, {dx}, {dy})");
            }
            Event::End {
                time,
                cancelled: canceled,
                ..
            } => {
                crate::say!(gesture.id(), "swipe_end({time}, {canceled})");
            }
            _ => unreachable!("the swipe protocol has only begin, update and end"),
        }
    }
}

impl Dispatch<zwp_pointer_gesture_hold_v1::ZwpPointerGestureHoldV1, ()> for Client {
    fn event(
        _: &mut Client,
        gesture: &zwp_pointer_gesture_hold_v1::ZwpPointerGestureHoldV1,
        event: zwp_pointer_gesture_hold_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        use zwp_pointer_gesture_hold_v1::Event;
        match event {
            Event::Begin { time, fingers, .. } => {
                crate::say!(gesture.id(), "hold_begin({time}, {fingers})");
            }
            Event::End {
                time,
                cancelled: canceled,
                ..
            } => {
                crate::say!(gesture.id(), "hold_end({time}, {canceled})");
            }
            _ => unreachable!("the hold protocol has only begin and end"),
        }
    }
}

delegate_noop!(Client: ignore zwp_pointer_gestures_v1::ZwpPointerGesturesV1);
delegate_noop!(Client: ignore zwp_relative_pointer_manager_v1::ZwpRelativePointerManagerV1);
delegate_noop!(Client: ignore zwp_pointer_constraints_v1::ZwpPointerConstraintsV1);

impl Dispatch<zwp_locked_pointer_v1::ZwpLockedPointerV1, ()> for Client {
    fn event(
        _: &mut Client,
        locked: &zwp_locked_pointer_v1::ZwpLockedPointerV1,
        event: zwp_locked_pointer_v1::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            zwp_locked_pointer_v1::Event::Locked => crate::say!(locked.id(), "locked()"),
            zwp_locked_pointer_v1::Event::Unlocked => crate::say!(locked.id(), "unlocked()"),
            _ => {}
        }
    }
}

impl Dispatch<zwp_confined_pointer_v1::ZwpConfinedPointerV1, ()> for Client {
    fn event(
        _: &mut Client,
        confined: &zwp_confined_pointer_v1::ZwpConfinedPointerV1,
        event: zwp_confined_pointer_v1::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        match event {
            zwp_confined_pointer_v1::Event::Confined => crate::say!(confined.id(), "confined()"),
            zwp_confined_pointer_v1::Event::Unconfined => {
                crate::say!(confined.id(), "unconfined()");
            }
            _ => {}
        }
    }
}

impl Dispatch<zwp_relative_pointer_v1::ZwpRelativePointerV1, ()> for Client {
    fn event(
        _: &mut Client,
        relative: &zwp_relative_pointer_v1::ZwpRelativePointerV1,
        event: zwp_relative_pointer_v1::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<Client>,
    ) {
        if let zwp_relative_pointer_v1::Event::RelativeMotion {
            dx,
            dy,
            dx_unaccel,
            dy_unaccel,
            ..
        } = event
        {
            crate::say!(
                relative.id(),
                "relative_motion({}, {}, {}, {})",
                dx,
                dy,
                dx_unaccel,
                dy_unaccel
            );
        }
    }
}
