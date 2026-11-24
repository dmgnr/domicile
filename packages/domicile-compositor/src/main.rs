//! `domicile-compositor`: the Wayland server for Domicile.
//!
//! The web engine renders the desktop, so this binary does no drawing of its
//! own. It serves the Wayland globals clients need, manages their surfaces and
//! buffers, and drives [`domicile_host::Host`]: a mapped toplevel calls
//! [`Host::app_appeared`] and a closed one calls [`Host::app_closed`].
//!
//! Client buffers reach the engine as viz surfaces (see `engine_session`).
//! `wl_shm` frames are first copied into a GPU buffer, or into memory for an
//! engine on the CPU (see `uploads`). Design:
//! `docs/architecture/WINDOW-COMPOSITING.md`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use smithay::input::{keyboard::XkbConfig, Seat, SeatState};
use smithay::reexports::{
    calloop::{
        channel::{channel, Event as ChannelEvent},
        generic::Generic,
        timer::{TimeoutAction, Timer},
        EventLoop, Interest, LoopHandle, Mode, PostAction, RegistrationToken,
    },
    wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration_manager::Mode as KdeDefaultMode,
    wayland_server::{
        protocol::{wl_callback::WlCallback, wl_surface::WlSurface},
        Display, DisplayHandle,
    },
};
use smithay::utils::{Clock, Monotonic, Serial};
use smithay::wayland::presentation::{PresentationFeedbackCallback, PresentationState};
use smithay::wayland::viewporter::ViewporterState;
use smithay::wayland::{
    compositor::CompositorState,
    content_type::ContentTypeState,
    cursor_shape::CursorShapeManagerState,
    dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufState},
    fractional_scale::FractionalScaleManagerState,
    idle_inhibit::IdleInhibitManagerState,
    keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitState,
    output::OutputManagerState,
    pointer_constraints::PointerConstraintsState,
    relative_pointer::RelativePointerManagerState,
    security_context::SecurityContextState,
    selection::data_device::DataDeviceState,
    selection::ext_data_control::DataControlState as ExtDataControlState,
    selection::primary_selection::PrimarySelectionState,
    selection::wlr_data_control::DataControlState as WlrDataControlState,
    shell::kde::decoration::KdeDecorationState,
    shell::xdg::decoration::XdgDecorationState,
    shell::xdg::{PopupSurface, ToplevelSurface, XdgShellState},
    shm::ShmState,
    single_pixel_buffer::SinglePixelBufferState,
    socket::ListeningSocketSource,
    xdg_activation::XdgActivationState,
};
use tracing::{debug, error, info, warn};

mod activation;
mod anchors;
mod app_scope;
mod bell;
mod blanking;
mod buffer_transform;
mod bus_names;
mod casting;
mod chrome_connection;
mod chrome_editor;
mod chrome_hub;
mod client_damage;
mod client_requests;
mod clients;
mod clipboard;
mod color_management;
mod compositor_casts;
mod config_adoption;
mod configure_answers;
mod configured_displays;
mod cursor_surface;
mod decorations;
mod display_sleep;
mod dmabuf_descriptor;
mod dmabuf_import;
mod eis;
mod electron_apps;
mod emulated_input;
mod engine;
mod engine_buffers;
mod engine_damage;
mod engine_imports;
mod engine_lingering;
mod engine_pump;
mod engine_retired;
mod engine_session;
mod engine_surfaces;
mod engine_waiting;
mod file_indexing;
mod foreign_toplevels;
mod frame_callbacks;
mod frame_descriptor;
mod frame_pacing;
mod frame_publishing;
mod frame_report;
mod gamma;
mod gamma_control;
mod gbm;
mod held_frames;
mod idle;
mod input_trace;
mod keymap;
mod latency;
mod latency_run;
mod launches;
mod lock;
mod locking;
mod log_levels;
mod logind;
mod memory_frames;
mod modifiers;
mod night_light;
mod notifications;
mod once_per_window;
mod outbound;
mod outputs;
mod pam;
mod peer_process;
mod pinch;
mod pnp_ids;
mod pointer_constraints;
mod popups;
mod portals;
mod presentations;
mod primary_node;
mod protocol_trace;
mod relative_pointer;
mod reply;
mod restatement;
mod scale;
mod screen_saver;
mod screencopy;
mod screens;
mod seat;
mod selections;
mod shell_config;
mod shm_upload;
mod shortcuts_inhibit;
mod spawning;
mod spike_probes;
mod subsurfaces;
mod surface_commit;
mod swipe;
mod synced_moves;
mod text_input;
mod theme_turnover;
mod thread_priority;
mod timing_window;
mod touch;
mod tray;
mod unlock_backoff;
mod uploads;
mod viewport;
mod virtual_monitors;
mod watchers;
mod web_agents;
mod which_engine;
mod window_geometry;
mod windows;
mod xdg_foreign;
mod xdg_shell;

use crate::engine::Bounds;
use crate::engine_session::EngineSession;
use crate::frame_callbacks::FrameCallbacks;
use crate::frame_publishing::Upload;
use crate::gbm::Gbm;
use crate::held_frames::HeldFrames;
use crate::latency::Latency;
use crate::log_levels::LogFilter;
use crate::presentations::Presentations;
use crate::shm_upload::render_modifiers;
use crate::uploads::Uploads;

use crate::chrome_connection::{bind_chrome_socket, serve_chrome};
use crate::chrome_hub::{serve_outbound, ChromeHub};
use crate::client_requests::ClientRequest;
use crate::clients::{accept_app_client, sees_privileged_globals, ClientState};
use crate::config_adoption::{
    hand_over_the_browser_profiles, hand_over_the_extensions, hand_over_the_shell_config,
    theme_on_the_wire,
};
use crate::configure_answers::ConfigureAnswers;
use crate::dmabuf_import::{headless_renderer, DmabufImporter};
use crate::eis::barriers::Zone;
use crate::engine_pump::poll_the_engine;
use crate::file_indexing::{keep_the_index, kept_at, Heard};
use crate::idle::Idle;
use crate::keymap::{compiled_keymap, listed_keymaps};
use crate::latency_run::spike_latency_point;
use crate::lock::{Lock, Verdict, Verifier};
use crate::modifiers::Held;
use crate::once_per_window::OncePerWindow;
use crate::outputs::{advertise_output, screens_at_startup, LiveOutput};
use crate::portals::{shell_appearance, Selection};
use crate::restatement::Restatement;
use crate::screens::{Advertised, Screens};
use crate::spawning::{chrome_display, home_directory, start_client};
use crate::subsurfaces::Subsurface;
use crate::surface_commit::{LastBuffer, Role};
use crate::windows::SizeLimits;
use domicile_config::{Config, ConfigError, ConfigStore};
use domicile_host::clipboard::{Contents, History};
use domicile_host::data_dirs::data_dirs;
use domicile_host::keymaps::Listed;
use domicile_host::priority;
use domicile_host::theme_turnover::Turnover;
use domicile_launch::arguments::arguments;
use domicile_launch::handshake::{silence, Handshake, WAIT_FOR_A_PAGE};
use domicile_launch::session::{publish, Session};
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::reexports::wayland_protocols_wlr::gamma_control::v1::server::zwlr_gamma_control_v1::ZwlrGammaControlV1;

/// Log messages that tests and operators search for by text.
///
/// Renaming one means updating the tests named on it. Not a complete list:
/// `packages/e2e-harness/tests/e2e-dmabuf.sh` and `tests/` also match unnamed messages such as
/// `toplevel drew`.
mod grepped {
    /// A chrome message that failed to parse.
    pub const UNPARSEABLE: &str = "unparseable chrome message";
    /// `set_output_scale` ignored a chrome's density on a described desktop.
    ///
    /// Waited on by `tests/desktop.rs`.
    pub const DENSITY_REFUSED: &str = "a described desktop keeps its own scale";
    /// `set_output_size` ignored a chrome's size on a described desktop.
    ///
    /// Waited on by `tests/desktop.rs`.
    pub const SIZE_REFUSED: &str = "a described desktop keeps its own size";
    /// The logical size and density an output was advertised at.
    ///
    /// Read this first when a chrome is laid out for the wrong screen.
    pub const ADVERTISING: &str = "advertising output scale";
    /// `spawn_client` forked a program. With [`ARRIVED`], it times a launch.
    ///
    /// Waited on by `tests/apps.rs`.
    pub const SPAWNING: &str = "spawning client";
    /// An app client connected to the socket.
    ///
    /// Waited on by `tests/apps.rs`.
    pub const ARRIVED: &str = "app client connected";
    /// [`take_up_the_keymaps`](crate::DomicileCompositor::take_up_the_keymaps)
    /// or [`switch_the_keymap`](crate::DomicileCompositor::switch_the_keymap)
    /// kept the old keymap because the new one did not compile.
    ///
    /// A refused reload sends no message, so this line is the only sign of it.
    /// Waited on by `tests/input.rs`.
    pub const KEYMAP_REFUSED: &str = "keeping the keymap the desktop is typing on";
    /// [`rebind_the_keys`](crate::DomicileCompositor::rebind_the_keys) kept
    /// the old keybindings because the new keyboard did not compile.
    ///
    /// A refused reload sends no message, so this line is the only sign of it.
    pub const KEYS_REFUSED: &str = "keeping the keys the shells were last told";
    /// [`activation::granted`](crate::activation::granted) dropped a focus
    /// request.
    ///
    /// A dropped request sends no message, so this line is the only sign of
    /// it. Waited on by `tests/focus.rs`.
    pub const FOCUS_REQUEST_DROPPED: &str = "focus request from before the keyboard last moved";
}

/// The renderer that imports client dmabufs and reads back shm buffers.
struct Gpu {
    renderer: Box<GlesRenderer>,
    importer: DmabufImporter,
    /// Allocates the buffers shm frames are copied into. `None` leaves shm
    /// clients blank; startup logs this once.
    gbm: Option<Gbm>,
}

impl Gpu {
    fn renderer(&mut self) -> &mut GlesRenderer {
        &mut self.renderer
    }
}

/// State threaded through the calloop event loop.
///
/// Holds the `Display` (not the Wayland source) so events queued by input
/// from other threads can be flushed.
struct CalloopData {
    display: Display<DomicileCompositor>,
    state: DomicileCompositor,
}

/// The compositor state: Wayland protocol globals and the shared hub.
struct DomicileCompositor {
    compositor_state: CompositorState,
    xdg_shell_state: XdgShellState,
    // Clients request focus through this. Not acted on directly; see
    // `XdgActivationHandler` in `xdg_shell.rs`.
    xdg_activation_state: XdgActivationState,
    // Decoration negotiation. The shell always draws decorations; see
    // `crate::decorations`.
    _xdg_decoration_state: XdgDecorationState,
    kde_decoration_state: KdeDecorationState,
    // Every client's inhibitor is honored; see `crate::shortcuts_inhibit`.
    keyboard_shortcuts_inhibit_state: KeyboardShortcutsInhibitState,
    shm_state: ShmState,
    seat_state: SeatState<DomicileCompositor>,
    seat: Seat<DomicileCompositor>,
    /// Kept alive so the xdg-output manager global persists.
    #[allow(dead_code)]
    output_manager_state: OutputManagerState,
    /// Every advertised output, in the same order as [`Screens`].
    ///
    /// The order must match one to one, because [`Screens::entered_by`] returns
    /// a positional list zipped against this. `set_output` updates in place,
    /// and [`adopt_the_desktop`](DomicileCompositor::adopt_the_desktop)
    /// replaces both lists together.
    ///
    /// See
    /// [`enter_the_displays_each_window_is_on`](DomicileCompositor::enter_the_displays_each_window_is_on).
    outputs: Vec<LiveOutput>,
    /// The live config, and the last edit that failed to parse.
    ///
    /// A [`ConfigStore`] keeps the live config when an edit fails to parse. A
    /// reload applies every field, through
    /// [`adopt_the_desktop`](DomicileCompositor::adopt_the_desktop) and
    /// [`adopt_the_rest_of_the_config`](DomicileCompositor::adopt_the_rest_of_the_config),
    /// so this is the config actually running. See [`crate::restatement`].
    ///
    /// A half-written save still parses. The watcher thread's coalescing
    /// handles that.
    config: ConfigStore,
    /// The outputs' layout, and whether the config or the chrome controls it.
    screens: Screens,
    /// The engine's last report of the monitors. Empty until it sends one.
    ///
    /// Always empty when nested: the engine does not watch displays then, since
    /// they would be the host's monitors.
    ///
    /// Kept so a config reload can be matched against the current monitors, not
    /// only a hotplug.
    engine_displays: Vec<engine::Display>,
    /// What `domicile configure-display` changed, until the desktop restarts.
    /// See [`configured_displays`].
    display_overrides: Vec<domicile_config::DisplayOverride>,
    /// The virtual monitors pages added, in the order they were. See
    /// [`virtual_monitors`].
    virtual_displays: Vec<engine::VirtualDisplay>,
    /// hwdata's `pnp.ids`, mapping EDID vendor codes to vendor names.
    ///
    /// Read once at startup; it cannot change between hotplugs. Empty if the
    /// machine has no copy, which is logged.
    vendors: pnp_ids::Vendors,
    /// The chrome's last reported `devicePixelRatio`.
    ///
    /// Used to convert the engine's device-pixel `<app>` bounds to logical
    /// units for a configure. See [`crate::scale::logical_box`]. Defaults to
    /// 1.0.
    device_pixel_ratio: f64,
    /// Drag-and-drop and the clipboard.
    ///
    /// Required: without `wl_data_device_manager`, an HTML5 drag in a page
    /// starts a Wayland drag that never completes, and the engine's nested loop
    /// freezes the chrome.
    data_device_state: DataDeviceState,
    /// The primary selection (middle-click clipboard).
    ///
    /// Separate from `wl_data_device`. Passed between clients and never read
    /// here, since it changes on every text selection and its history would be
    /// noise.
    primary_selection_state: PrimarySelectionState,
    /// `ext-data-control-v1`: clipboard managers, `wl-copy` and `wl-paste`
    /// read and set both selections with no window focused.
    ///
    /// Shares the seat's selections with `wl_data_device` and the primary
    /// selection, so its copies reach [`DomicileCompositor::clipboard`] through
    /// the same `SelectionHandler`.
    ext_data_control_state: ExtDataControlState,
    /// `zwlr_data_control_v1`, the same for clients that predate
    /// `ext-data-control-v1`.
    wlr_data_control_state: WlrDataControlState,
    /// Clipboard history, newest first.
    ///
    /// A Wayland clipboard disappears with the client that offered it. This
    /// history keeps copies after the client exits. The compositor holds it
    /// because `set_selection` arrives only here. Policy lives in
    /// `domicile_host::clipboard`.
    clipboard: History,
    /// The mime types to read from a new selection, one slot per clipboard.
    ///
    /// Read one dispatch later because Smithay calls `new_selection` before
    /// storing the selection on the seat.
    /// [`DomicileCompositor::read_what_was_copied`] uses it at the end of the
    /// dispatch, before the flush. Empty means no text or image, which is not
    /// recorded.
    ///
    /// One slot per clipboard because a client can set both in one dispatch.
    copying: [Vec<String>; 2],
    /// What is on each clipboard now, whoever set it.
    ///
    /// Differs from the history: this is what a paste would produce now,
    /// including an old history entry the shell restored.
    ///
    /// Needed for the browser, which is not a Wayland client here and cannot be
    /// served by another client directly. It also serves Wayland clients
    /// pasting what the browser copied. See [`Clipboard`].
    holding: [Option<Contents>; 2],
    /// The display handle, for paths that do not start at the event loop:
    /// moving clipboard focus with the keyboard (a `SeatHandler` callback) and
    /// restoring a history entry (a chrome request).
    display_handle: DisplayHandle,
    /// Kept alive so the wp_cursor_shape_v1 global persists.
    #[allow(dead_code)]
    cursor_shape_state: CursorShapeManagerState,
    /// Kept alive so the zwp_relative_pointer_manager_v1 global persists. See
    /// `crate::relative_pointer`.
    #[allow(dead_code)]
    relative_pointer_state: RelativePointerManagerState,
    /// Kept alive so the zwp_pointer_constraints_v1 global persists. See
    /// `crate::pointer_constraints`.
    #[allow(dead_code)]
    pointer_constraints_state: PointerConstraintsState,
    /// The lock or confinement offered to the page, for the window under the
    /// pointer. See `crate::pointer_constraints`.
    pointer_constraint_offered: Option<crate::pointer_constraints::Offered>,
    /// Composition from an input method. See [`text_input`].
    text_input: text_input::TextInput,
    /// The browser's stand-in on the input method relay, connected at the
    /// browser's first text field. See [`chrome_editor`].
    chrome_editor: Option<chrome_editor::ChromeEditor>,
    /// Whether the browser's keys go to the input method first, as last told.
    composing: bool,
    /// The next serial for the browser's input method messages. See
    /// `next_ime_serial`.
    ime_serial: Option<u64>,
    dmabuf_state: DmabufState,
    /// Kept alive so the zwp_linux_dmabuf_v1 global persists. `None` where EGL
    /// gave us no renderer, in which case the global was never advertised.
    #[allow(dead_code)]
    dmabuf_global: Option<DmabufGlobal>,
    /// The renderer client buffers are imported on.
    ///
    /// Present exactly when the dmabuf global is, so a committed dmabuf always
    /// has somewhere to go.
    gpu: Option<Gpu>,

    /// State shared with the chrome connection threads.
    hub: Arc<ChromeHub>,
    /// Whether clients start in their own systemd scopes; see
    /// [`crate::app_scope`].
    scope_clients: bool,
    /// The clients launched from the chrome, kept for the next compositor;
    /// see [`crate::launches`]. `None` when started without `--launches`.
    launched: Option<Arc<launches::Launches>>,
    /// Where the entries that run `electron.apps` on the engine go; see
    /// [`crate::electron_apps`]. `None` writes none.
    electron_entries: Option<PathBuf>,
    /// Mapped toplevels, paired with the host-assigned app id (Wayland-thread only).
    toplevels: Vec<(String, ToplevelSurface)>,
    /// Where the page last said each window is, in desktop logical units
    /// (`ChromeMessage::SetAppBounds`). Decides its displays and scale; see
    /// [`place_window`](DomicileCompositor::place_window). A hidden window
    /// keeps its last box here; input and casts read
    /// [`HeldFrames::shown`].
    app_bounds: HashMap<String, domicile_scene::Bounds>,
    /// Each window's CSS `zoom`, from the engine's configure. Multiplies the
    /// scale it draws at, and its popups', so a zoomed window stays sharp. A
    /// window not here is at 1. See [`crate::scale::zoomed`].
    app_zoom: HashMap<String, f64>,
    /// Each monitor's night light and gamma-control client
    /// (`SystemRequest::SetColorTemperature`, `zwlr_gamma_control_v1`), sent
    /// again to an engine that reports its displays, since a new engine
    /// starts neutral.
    gamma: gamma::Ramps<ZwlrGammaControlV1>,
    /// The night light the shell set, and its fade into `gamma`.
    night_light: night_light::NightLight,
    /// Whether the next frame of the night light's fade is due, so one timer
    /// draws it.
    night_light_frame_due: bool,
    /// The `wp_color_management_output_v1`s clients hold, told when their
    /// display goes into or out of HDR.
    display_colors: color_management::DisplayColors,
    /// Frame callbacks of the windows the page hides. See
    /// [`crate::held_frames`].
    held_frames: HeldFrames<WlCallback>,
    /// The windows marked `suspended`, so the chromes hear only changes.
    suspended: HashSet<String>,
    /// Which frame of each window the chromes hear was presented. See
    /// [`crate::presentations`].
    presentations: Presentations,
    /// Frame callbacks and presentation feedback waiting for the engine to
    /// report their frame. See [`crate::frame_callbacks`].
    frame_callbacks: FrameCallbacks<WlCallback, PresentationFeedbackCallback>,
    /// Whether the timer that answers frames past
    /// [`crate::frame_callbacks::DEADLINE`] is armed.
    frame_deadline_armed: bool,
    /// `wp_presentation`'s clock, which the engine's presentation times use.
    clock: Clock<Monotonic>,
    /// Every announced popup (menus), by its host-assigned id.
    ///
    /// The engine treats each as its own app, placed rather than laid out; see
    /// `HostMessage::PopupPlaced`. Announced once it has a buffer.
    popups: Vec<(String, PopupSurface)>,
    /// Popups holding a grab, outermost first.
    ///
    /// They have the keyboard while open. Focus moving anywhere but their
    /// window dismisses them all; see `ClientRequest::KeyboardFocus`.
    grabbing: Vec<PopupSurface>,
    /// Every subsurface of a window, a popup or another subsurface, which
    /// its parent's frames draw. See `crate::subsurfaces`.
    subsurfaces: Vec<Subsurface>,
    /// The number of the last subsurface, for its id.
    next_subsurface: u64,
    /// Popup moves of the commit transaction being applied, held so each
    /// names the frames it shows with. See `surface_commit`.
    synced_moves: crate::synced_moves::SyncedMoves,
    /// The app the pointer is currently over, so a `set_cursor` request can be
    /// attributed to the element the chrome should restyle.
    pointer_app: Option<String>,
    /// The surface the client under the pointer draws its cursor on, if it
    /// asked for one. See `crate::cursor_surface`.
    cursor_surface: Option<WlSurface>,
    /// The surface of `pointer_app` the pointer is over: the window, or a
    /// subsurface of it that takes input. See
    /// [`DomicileCompositor::input_target`].
    pointer_surface: Option<WlSurface>,
    /// Pointer buttons the seat was told are down, in the order pressed.
    ///
    /// Smithay keeps this list too but does not expose it. See
    /// [`DomicileCompositor::let_go_of_lost_presses`].
    held_buttons: Vec<u32>,
    pinch: Option<pinch::ActivePinch>,
    swipe: Option<swipe::ActiveSwipe>,
    touches: Option<touch::ActiveTouches>,
    touch_clients: touch::TouchClients,
    /// InputCapture sessions, which take input once the pointer reaches a
    /// barrier. Set when the Wayland loop starts serving EIS. See
    /// [`crate::eis`].
    captures: Option<eis::Captures>,
    /// For frame-callback timestamps.
    start: Instant,
    /// When the last buffer commit finished, to time the gap to the next. Not
    /// per app: it measures whether this thread was busy.
    last_commit: Option<Instant>,
    /// When the oldest unanswered keystroke was injected. Only the oldest is
    /// kept, matching the chrome: a burst answered by one frame feels as slow
    /// as its first key.
    pending_key: Option<Instant>,
    /// The keystroke-to-pixel measurement. `None` unless
    /// `DOMICILE_SPIKE_LATENCY` names a point.
    latency: Option<Latency>,
    /// The app being measured: the first to commit.
    latency_app: Option<String>,
    /// Whether the latency report was logged. Logged once, though the client
    /// keeps drawing.
    latency_reported: bool,
    /// The display frame viz last reported, for a latency run that starts
    /// after it.
    latency_frame: Option<Duration>,
    /// The chrome's own toplevel, if it is our client.
    ///
    /// Kept apart from `toplevels` because it is the desktop, not an app: never
    /// announced, and the keyboard falls back to it.
    chrome_toplevel: Option<ToplevelSurface>,
    /// Clients whose shm frame could not be copied, already logged. Logged once
    /// per client, not per frame.
    shm_refused: OncePerWindow,
    /// The buffers shm frames are copied into: GPU buffers, so the engine gets
    /// a dmabuf, or memfds for an engine on the CPU. See [`crate::uploads`].
    uploads: Uploads<Upload>,
    /// Whether the engine composites on the CPU, so shm frames go to it in
    /// memory: as the launcher said, then as the engine says. See
    /// [`crate::memory_frames`] and [`DomicileCompositor::engine_composites`].
    software_compositing: bool,
    /// Whether emulated input goes to the engine instead of the seat, as on
    /// a headless desk. See [`crate::eis::Compositor::engine_takes_input`].
    engine_takes_input: bool,
    /// Each toplevel's numbered configures, so a commit is shown at the box
    /// it was drawn for. See [`crate::configure_answers`].
    configure_answers: HashMap<String, ConfigureAnswers<Serial>>,
    /// Each window's previous commit, if the engine shows it whole, so the
    /// next can carry only the client's damage. See [`crate::engine_damage`].
    shown: engine_damage::Shown,
    /// The size limits each window's chromes were last told, so a commit
    /// that keeps them does not lock the host.
    size_limits: HashMap<String, SizeLimits>,
    /// Each window's last buffer, for a commit that attaches none but changes
    /// how it maps. See `surface_commit`.
    last_buffers: HashMap<String, LastBuffer>,
    /// Windows that have not drawn yet, which the chromes have not heard of.
    /// See `announce_a_new_window`.
    unannounced: HashSet<String>,
    /// Every announced surface's app id and role, kept in step with
    /// `toplevels`, `popups` and `subsurfaces`, so a commit finds its window
    /// without searching them.
    by_surface: HashMap<WlSurface, (String, Role)>,

    /// Apps whose first frame the engine accepted, logged once each.
    ///
    /// Mapping, getting a sink and being configured do not mean a window drew
    /// anything.
    first_frame_logged: OncePerWindow,

    /// Temporary, part of the pixel probe. When the probe last ran.
    ///
    /// The probe blocks this thread on a viz readback. Running it per submit
    /// with two clients would starve the event loop and stop buffer releases.
    /// Guards poll for tens of seconds, so four runs a second is enough.
    last_probe: Option<Instant>,

    /// Temporary. Points the probe refused, logged once each.
    probe_refused: HashSet<(i32, i32)>,

    /// Temporary. Colors already reported absent, logged once each.
    probe_missing: HashSet<u32>,

    /// Temporary. Colors the probe could not read at all.
    ///
    /// Separate from `probe_missing` so "not on screen" and "nothing was read"
    /// do not hide each other.
    probe_unreadable: HashSet<u32>,

    /// Temporary. When the color search last ran. Throttled harder than the
    /// point probe because it reads back the whole window.
    last_find: Option<Instant>,

    /// Temporary. When the color search first ran; its budget counts from here.
    /// Not from startup, so waiting for a client does not spend the budget.
    find_since: Option<Instant>,

    /// Temporary. The last box logged for each color, so a box is logged
    /// whenever it moves. A window still painting is smaller than it will be.
    ///
    /// A color is present only while found.
    probe_boxes: HashMap<u32, Bounds>,

    /// Temporary. Whether the search is done: every color found and stable, or
    /// the budget spent. Stops the blocking readbacks.
    find_settled: bool,
    /// The chrome's last frame shape, so its log line is printed only on
    /// change.
    chrome_frame_shape: Option<((f64, f64), bool, bool)>,
    /// Which modifiers the chrome was last told are held.
    modifiers: Held,
    /// Set when the user closes the desktop window. The event loop reads it and
    /// stops.
    stop: Arc<AtomicBool>,
    /// The forked engine, when `--engine-socket` is given.
    ///
    /// `None` leaves no way to show windows, which startup logs. `Some` submits
    /// client dmabufs to viz and holds `wl_buffer.release` until viz is done;
    /// see [`engine_session::EngineSession`].
    engine: Option<EngineSession>,
    /// The registration watching the engine's fd.
    ///
    /// Kept so a replacement engine can be watched instead. The old fd is
    /// closed by the library, and a calloop source can only be removed by its
    /// token.
    engine_source: Option<RegistrationToken>,
    /// The browser process serving the last page that said hello.
    ///
    /// `None` until the first hello, which is always the engine dialed at
    /// startup. See [`crate::which_engine`].
    engine_process: Option<i32>,
    /// The engine said its browser went away, so the next hello is a new one.
    /// See [`crate::which_engine`].
    engine_disconnected: bool,
    /// Idle tracking: blanking, locking and the shell's idle watches.
    ///
    /// Replaced by
    /// [`reset_the_idle_clock`](DomicileCompositor::reset_the_idle_clock) when
    /// a reload changes `idle`.
    ///
    /// Inhibitors are held as their surfaces. An inhibitor counts only if its
    /// surface is [`StillThere`] and among
    /// [`surfaces_on_the_desktop`](DomicileCompositor::surfaces_on_the_desktop).
    idle: Idle<WlSurface>,
    /// `domicile mcp --relay`, while `agents.web` is set.
    web_agents: crate::web_agents::WebAgents,
    /// Whether somebody put the screens to sleep. Independent of `idle`,
    /// so it works on a desktop with no timeout.
    display_sleep: crate::display_sleep::DisplaySleep,
    /// The applications holding the portal's idle inhibitors, one name per
    /// inhibitor, which the shell is told along with the Wayland ones. See
    /// [`DomicileCompositor::tell_the_shells_what_holds_the_desktop_awake`].
    held_by_portal_apps: Vec<String>,
    /// What applications asked `org.freedesktop.ScreenSaver` to hold. See
    /// [`screen_saver`].
    held_by_screen_saver: Vec<screen_saver::Hold>,
    /// Sends reloads to the file index thread. `None` without a home to index.
    ///
    /// Only `files.omit` changes go here. See
    /// [`omit_from_the_index`](DomicileCompositor::omit_from_the_index).
    index: Option<mpsc::Sender<Heard>>,
    /// The idle timer, if any.
    ///
    /// Kept so a reload can remove or replace it; a calloop source can only be
    /// removed by its token.
    idle_clock: Option<RegistrationToken>,
    /// The timer for the shell's next idle watch, if one is due. See
    /// [`settle_the_idle_watches`](DomicileCompositor::settle_the_idle_watches).
    idle_watch_clock: Option<RegistrationToken>,
    /// The lock, opened by PAM through `lock.pam_service`.
    ///
    /// Kept across reloads, which only swap its verifier
    /// ([`rekey_the_lock`](DomicileCompositor::rekey_the_lock)). Rebuilding it
    /// would unlock the desktop.
    lock: Lock,
    /// logind's delay inhibitor on sleep, closed once the desktop has locked
    /// for it. See [`crate::logind`].
    sleep_inhibitor: Option<std::os::fd::OwnedFd>,
    /// Where PAM services are read from: [`pam::SERVICES`] unless the command
    /// line names another. Kept for the verifier a reload builds.
    pam_confdir: PathBuf,
    /// The theme change in progress, if any, and its current phase's deadline.
    turnover: Option<Turnover<usize>>,
    turnover_deadline: Option<RegistrationToken>,
    /// Window, monitor and region streams. See [`crate::casting`].
    casting: casting::Streams,
    /// Starts the casts Wayland capture clients take. See
    /// [`crate::screencopy`].
    screen_copying: casting::Casting,
    /// The casts Wayland capture clients take.
    copies: screencopy::Copies,
    /// The windows, as capture tools list them.
    foreign_toplevels: foreign_toplevels::ForeignToplevels,
    /// When the soonest superseded engine hold expires, if one is held. See
    /// [`crate::engine_buffers`].
    hold_deadline: Option<RegistrationToken>,
    /// When the next paced cast frame is sent, if one waits.
    cast_deadline: Option<RegistrationToken>,
    /// `DOMICILE_CAST_WINDOW`: the title of a window to cast as soon as it has
    /// it, and the handle to start the cast with. Taken when it starts.
    cast_on_title: Option<(String, casting::Casting)>,
    /// `DOMICILE_CAST_MONITOR`: a monitor's `wl_output` name or a region to
    /// cast (see [`casting::Source::desk`]), and the handle to start the cast
    /// with. Taken when it starts.
    cast_on_monitor: Option<(String, casting::Casting)>,
    /// `DOMICILE_CAST_TEST_PATTERN`: monitor and region casts draw one color
    /// when no engine captures the displays.
    cast_test_pattern: Option<casting::TestPattern>,
    /// The event loop handle, for adding sources after startup.
    ///
    /// Only the idle timer needs it: a reload may add a timeout the startup
    /// config did not have.
    loop_handle: LoopHandle<'static, CalloopData>,
}

impl DomicileCompositor {
    fn now_ms(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }
}

/// Advertise `zwp_linux_dmabuf_v1`, with feedback when the DRM node is known.
///
/// Feedback (v4) tells clients which device to allocate on. Without `wl_drm`,
/// Mesa has no other source and never allocates against a v3 global. v3 remains
/// for software rendering, which has no node.
fn advertise_dmabuf(
    state: &mut DmabufState,
    display: &DisplayHandle,
    main_device: Option<u64>,
    formats: Vec<smithay::backend::allocator::Format>,
) -> DmabufGlobal {
    let feedback = main_device.and_then(|device| {
        match DmabufFeedbackBuilder::new(device, formats.clone()).build() {
            Ok(feedback) => Some(feedback),
            Err(err) => {
                tracing::error!(%err, "cannot build dmabuf feedback; falling back to v3");
                None
            }
        }
    });
    debug!(
        count = formats.len(),
        feedback = feedback.is_some(),
        "advertising zwp_linux_dmabuf_v1"
    );
    match feedback {
        Some(feedback) => {
            state.create_global_with_default_feedback::<DomicileCompositor>(display, &feedback)
        }
        None => state.create_global::<DomicileCompositor>(display, formats),
    }
}

/// The libgbm device on the renderer's GPU, for copying shm frames.
///
/// `None` is logged once here, since it blanks every shm window.
fn shm_allocator(importer: &DmabufImporter) -> Option<Gbm> {
    let Some(node) = importer.node() else {
        error!(
            "EGL renders on no DRM node — a software rasterizer — so there is no GPU to copy \
             shared-memory clients' frames onto; their windows will be blank"
        );
        return None;
    };
    match Gbm::open(gbm::LIBRARY, node) {
        Ok(gbm) => Some(gbm),
        Err(err) => {
            error!(%err, "shared-memory clients' windows will be blank");
            None
        }
    }
}

/// Run the compositor, printing a readable error if it fails to start.
///
/// Not `main() -> Result`, because `Termination` prints errors with `Debug`,
/// which escapes newlines and wraps the variant name. Startup errors are what a
/// user reads when the desktop will not come up, so print them with `Display`,
/// as `bin/domicile.rs` does.
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("domicile-compositor: {why}");
            ExitCode::FAILURE
        }
    }
}

/// Starts tracing, at `RUST_LOG`'s levels or `INFO`, and returns the filter
/// `domicile set-log-level` reloads.
///
/// When stdout is the journal, each event is an entry under
/// `domicile-compositor` with its level as the priority, so `journalctl -p err`
/// finds the compositor's errors. Otherwise events are formatted to stdout,
/// colored only on a terminal: in a file, escape codes break searches like
/// `grep pid=1234`.
fn start_logging() -> Result<LogFilter, Box<dyn std::error::Error>> {
    use std::io::IsTerminal;
    use std::os::fd::AsFd;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let starting = std::env::var("RUST_LOG")
        .ok()
        .filter(|directives| tracing_subscriber::EnvFilter::try_new(directives).is_ok())
        .unwrap_or_else(|| "info".to_string());
    let (filter, handle) =
        tracing_subscriber::reload::Layer::new(tracing_subscriber::EnvFilter::try_new(&starting)?);
    let stdout = std::io::stdout();
    let journal = domicile_launch::journal::is_the_journal(stdout.as_fd());
    tracing_subscriber::registry()
        .with(filter)
        .with(
            journal
                .then(tracing_journald::layer)
                .transpose()?
                .map(|layer| {
                    layer.with_syslog_identifier(
                        domicile_launch::component_log::COMPOSITOR.to_string(),
                    )
                }),
        )
        .with((!journal).then(|| tracing_subscriber::fmt::layer().with_ansi(stdout.is_terminal())))
        .init();
    Ok(LogFilter::new(starting, handle))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let log_filter = start_logging()?;

    // Read before any thread is raised, so the processes the desktop starts
    // run at the priority it was started at.
    let child_nice = priority::nice(priority::this_thread())?;

    // Parse arguments before binding anything. Another program writes them, so
    // an error is a bug and should not be buried in the startup log.
    let arguments = arguments(std::env::args_os().skip(1))?;

    // A config that will not load is fatal. Shells generate it, so a bad one
    // means a broken shell, and falling back to defaults would hide that.
    let config = match &arguments.config {
        Some(path) => Config::load(path)?,
        None => Config::default(),
    };
    // Every process started from here on is told it; see `desk_terminal`.
    domicile_host::desk_terminal::set(config.terminal.clone());
    // Before any client starts, so the launcher's first listing has them.
    if let Some(out) = &arguments.electron_entries {
        electron_apps::write_the_electron_entries(out, &config.electron.apps);
    }

    let mut event_loop: EventLoop<CalloopData> = EventLoop::try_new()?;
    let display: Display<DomicileCompositor> = Display::new()?;
    let dh = display.handle();
    // Delegated compositing: Chromium sends one subsurface per quad, but only
    // to a compositor that advertises these. `wl_subcompositor` comes with
    // `CompositorState`. See `docs/architecture/WINDOW-COMPOSITING.md`.
    //
    // Advertising `wp_viewporter` commits to honoring it: Chromium then sets
    // its logical size through `wp_viewport.set_destination` instead of a
    // buffer scale. If ignored, every surface on a dense display is twice its
    // size. See `viewport`.
    ViewporterState::new::<DomicileCompositor>(&dh);
    // Presentation times come from viz, on `CLOCK_MONOTONIC`. See
    // `crate::frame_callbacks`.
    PresentationState::new::<DomicileCompositor>(&dh, Clock::<Monotonic>::new().id() as u32);
    // A window's exact scale, which `wl_output.scale` rounds up. Clients that
    // use it draw through `wp_viewporter`. See `place_window`.
    FractionalScaleManagerState::new::<DomicileCompositor>(&dh);
    SinglePixelBufferState::new::<DomicileCompositor>(&dh);
    ContentTypeState::new::<DomicileCompositor>(&dh);
    // Always advertised, even without an idle timeout, so a reload never
    // removes a global a client has bound.
    IdleInhibitManagerState::new::<DomicileCompositor>(&dh);
    // Terminal bells, for the shell. See `bell`.
    smithay::wayland::xdg_system_bell::XdgSystemBellState::new::<DomicileCompositor>(&dh);
    // `parent_window` handles for portal dialogs.
    xdg_foreign::advertise(&dh);
    // Screenshot and recording tools such as `grim` and `wf-recorder`, and
    // the windows they may capture.
    screencopy::advertise(&dh);
    // Night-light tools such as gammastep and wl-gammarelay-rs.
    gamma_control::advertise(&dh);
    color_management::advertise(&dh);
    let foreign_toplevels = foreign_toplevels::ForeignToplevels::new(&dh);
    // Input methods compose text into native windows.
    let text_input = text_input::TextInput::advertise(&dh);
    // Windows laid out at a named place in the page.
    anchors::advertise(&dh);

    let mut seat_state = SeatState::new();
    let data_device_state = DataDeviceState::new::<DomicileCompositor>(&dh);
    let primary_selection_state = PrimarySelectionState::new::<DomicileCompositor>(&dh);
    // Every unsandboxed client sees both, as a clipboard manager is an
    // ordinary client.
    let ext_data_control_state = ExtDataControlState::new::<DomicileCompositor, _>(
        &dh,
        Some(&primary_selection_state),
        sees_privileged_globals,
    );
    let wlr_data_control_state = WlrDataControlState::new::<DomicileCompositor, _>(
        &dh,
        Some(&primary_selection_state),
        sees_privileged_globals,
    );
    // Sandbox engines such as Flatpak open a listener for their clients here.
    SecurityContextState::new::<DomicileCompositor, _>(&dh, sees_privileged_globals);
    // Advertise a keyboard and pointer.
    let mut seat: Seat<DomicileCompositor> = seat_state.new_wl_seat(&dh, "domicile");
    // The seat's keymap is what every client receives: the config's first. A
    // keymap xkb cannot compile is fatal at startup rather than silently
    // replaced, the ones the desktop can switch to as well. On reload,
    // `take_up_the_keymaps` refuses them instead, since windows are open.
    let keymaps = config.input.keyboard.keymaps();
    for keymap in &keymaps[1..] {
        compiled_keymap(keymap)?;
    }
    let keyboard = &keymaps[0];
    seat.add_keyboard(
        XkbConfig {
            rules: &keyboard.xkb_rules,
            model: &keyboard.xkb_model,
            layout: &keyboard.xkb_layout,
            variant: &keyboard.xkb_variant,
            options: Some(keyboard.xkb_options_string()),
        },
        config.input.keyboard.repeat.delay_ms.into(),
        config.input.keyboard.repeat.rate.into(),
    )?;
    // The same keymap as text, for the browser process, which has its own
    // layout engine and no fd. Compiled here because Smithay only exposes the
    // seat's keymap later, after the chrome socket accepts connections. See
    // `keymap`.
    let keymap = compiled_keymap(keyboard)?;
    // Resolve keybindings on it. Fatal at startup like the keymap, so no
    // binding silently does nothing. A reload refuses instead; see
    // `rebind_the_keys`.
    let keys = shell_config::keys(keyboard)?;
    seat.add_pointer();
    // Always, so a client with touch support finds it before the first
    // finger; a client without it gets the pointer (see `touch`).
    seat.add_touch();
    let _pointer_gestures =
        smithay::wayland::pointer_gestures::PointerGesturesState::new::<DomicileCompositor>(&dh);

    // Advertise an output per described display, or one following Domicile's
    // window. Some clients (e.g. weston-terminal) wait for a `wl_output` before
    // mapping, so do this before opening the socket.
    let output_manager_state = OutputManagerState::new_with_xdg_output::<DomicileCompositor>(&dh);
    let screens = screens_at_startup(&config);
    let cast_screens = screens.cast_screens();
    let outputs: Vec<LiveOutput> = screens
        .outputs()
        .map(|advertised| advertise_output(&dh, advertised))
        .collect();

    // Bind the Wayland socket before anything can spawn a client. A chrome may
    // send `spawn` as soon as it connects, and the client needs our display
    // name. The event loop source is added later.
    //
    // A compositor that replaces one that crashed binds the same name, so a
    // client that reconnects finds it, and launches again the clients the
    // crash took. See `launches`.
    let left = arguments
        .launches
        .as_deref()
        .map(|path| launches::left(path, launches::started))
        .unwrap_or_default();
    let source = match left
        .wayland_display
        .as_deref()
        .map(ListeningSocketSource::with_name)
    {
        Some(Ok(source)) => source,
        Some(Err(err)) => {
            tracing::error!(%err, "the last compositor's display would not bind; reconnecting clients will not find this one");
            ListeningSocketSource::new_auto()?
        }
        None => ListeningSocketSource::new_auto()?,
    };
    let socket_name = source.socket_name().to_os_string();
    let launched = arguments.launches.clone().map(|path| {
        Arc::new(launches::Launches::new(
            path,
            socket_name.to_string_lossy().into_owned(),
        ))
    });
    // A second socket for the chrome, which identifies it; see
    // `ClientState::is_chrome`.
    let chrome_socket_name = chrome_display(&socket_name);
    let chrome_source = ListeningSocketSource::with_name(&chrome_socket_name)?;
    // One line each, so scripts can match each display separately.
    info!(
        display = ?socket_name,
        "domicile-compositor: apps connect here (WAYLAND_DISPLAY)"
    );
    debug!(
        display = ?chrome_socket_name,
        "domicile-compositor: the chrome connects here (WAYLAND_DISPLAY)"
    );

    // Chrome requests to the Wayland thread.
    let (request_tx, request_rx) = channel::<ClientRequest>();
    // Cast and shot requests from any thread, such as the portals'.
    let (cast_requests, heard_cast_requests) = channel::<casting::Request>();
    // Passphrase verdicts from the checking thread.
    let (verdicts, heard_verdicts) = channel::<Verdict>();

    // Whether this desk queues behind its host's bus names. See `bus_names`.
    let in_a_window = bus_names::in_a_window(std::env::var_os("WAYLAND_DISPLAY").as_deref());
    // Notifications, from the bus and from the portal. Published once the hub
    // exists. See `notifications`.
    let notification_server = notifications::serve(
        data_dirs(
            std::env::var_os("XDG_DATA_HOME"),
            std::env::var_os("XDG_DATA_DIRS"),
            home_directory().as_deref(),
        ),
        config.theme.icon_theme.clone(),
        {
            let display = socket_name.clone();
            let scoped = arguments.scope_clients;
            let launched = launched.clone();
            Box::new(move |command, token| {
                start_client(
                    command,
                    &display,
                    scoped,
                    child_nice,
                    Some(token),
                    launched.as_ref(),
                )
            })
        },
        in_a_window,
    );
    // State shared by the Wayland thread and chrome connections.
    let (hub, outbound_rx) = ChromeHub::new(
        request_tx,
        config.output.max_scale,
        socket_name.clone(),
        child_nice,
        // Start before any client is spawned: an app asking for a color scheme
        // before the bus name is taken would get another backend's answer and
        // never ask again.
        portals::serve(
            theme_on_the_wire(config.theme.mode),
            &config.theme,
            config.lockdown.clone(),
            &socket_name.to_string_lossy(),
            in_a_window,
            notification_server.clone(),
            {
                let display = socket_name.clone();
                let scoped = arguments.scope_clients;
                let launched = launched.clone();
                move |command| {
                    start_client(
                        command,
                        &display,
                        scoped,
                        child_nice,
                        None,
                        launched.as_ref(),
                    )
                }
            },
            portals::ScreenCasting {
                casting: casting::Casting::new(cast_requests.clone()),
                grants: domicile_launch::profile_path::state_directory(&|key| {
                    std::env::var(key).ok()
                })
                .map(|directory| directory.join("screen-cast-grants.v2.json")),
            },
        ),
    );
    // Before any chrome connects, so a page that asks hears them at once.
    hub.keymaps.list(Listed {
        keymaps: listed_keymaps(&keymaps),
        active: keyboard.name.clone(),
    });
    // Before any chrome connects, so the handshake carries the desktop.
    {
        let mut host = hub.host.lock().unwrap();
        host.describe_displays(screens.outputs().map(Advertised::described).collect());
        host.describe_monitors(screens.outputs().map(Advertised::monitor).collect());
        hub.portals
            .displays(screens.outputs().map(Zone::from).collect());
        // The keymap, for the browser process to decode keys. Outside ChromeOS
        // nothing else gives Chromium's layout engine one. See `keymap`.
        host.set_keymap(keymap);
        // Keybindings and the shell's options, so a reloaded page gets them
        // again.
        hand_over_the_shell_config(&mut host, keys, shell_config::options(&config));
        // Extensions, which the browser process installs. See
        // `docs/architecture/EXTENSIONS.md`.
        hand_over_the_extensions(&mut host, &config.extensions);
        // Browser profiles, which the browser process opens pages in. See
        // `docs/architecture/BROWSER-PROFILES.md`.
        hand_over_the_browser_profiles(&mut host, &config.browser);
        // Sites the browser draws dark while the theme is dark.
        host.set_force_dark(config.theme.force_dark.clone());
        // Whether and in which languages the browser checks spelling.
        host.set_spellcheck(
            config.spellcheck.enabled,
            config.spellcheck.languages.clone(),
        );
        // The theme, so the page paints correctly the first time. Set, not
        // `take_up_the_theme`, since there is nobody to broadcast to yet.
        host.set_theme(theme_on_the_wire(config.theme.mode));
        host.set_windows_theme(theme_on_the_wire(config.theme.mode));
        // The rest of the config's look, which the shell follows as the
        // settings portal's clients do.
        host.set_appearance(shell_appearance(&config.theme));
    }
    // The system tray, published through the hub. Start with an empty tray so a
    // desktop without a session bus still reports one. See `tray`.
    hub.host.lock().unwrap().set_tray(Vec::new());
    let publishing = Arc::clone(&hub);
    if hub.log_filter.set(log_filter).is_err() {
        unreachable!("the log filter is set once, here");
    }
    let _ = hub.tray.set(tray::serve(
        data_dirs(
            std::env::var_os("XDG_DATA_HOME"),
            std::env::var_os("XDG_DATA_DIRS"),
            home_directory().as_deref(),
        ),
        config.theme.icon_theme.clone(),
        in_a_window,
        move |items| {
            // Release the host before broadcasting.
            let told = publishing.host.lock().unwrap().set_tray(items);
            if let Some(message) = told {
                publishing.broadcast(message);
            }
        },
    ));
    // Notifications, published like the tray. Listening publishes the current
    // list. See `notifications`.
    let publishing = Arc::clone(&hub);
    notification_server.listen(move |items| {
        let told = publishing.host.lock().unwrap().set_notifications(items);
        if let Some(message) = told {
            publishing.broadcast(message);
        }
    });
    let _ = hub.notifications.set(notification_server);
    // Portal dialogs, published like notifications, starting empty. A dialog
    // asked for while no chrome is connected is refused; its `parent_window`
    // resolves through the `xdg_foreign` exports. See `portals`.
    hub.host
        .lock()
        .unwrap()
        .set_portal_requests(Vec::new(), Vec::new());
    let publishing = Arc::clone(&hub);
    let asking = Arc::clone(&hub);
    let resolving = Arc::clone(&hub);
    hub.portals.listen(
        move |items, capturing| {
            let told = publishing
                .host
                .lock()
                .unwrap()
                .set_portal_requests(items, capturing);
            if let Some(message) = told {
                publishing.broadcast(message);
            }
        },
        move || !asking.chromes.lock().unwrap().is_empty(),
        move |parent_window| {
            resolving
                .host
                .lock()
                .unwrap()
                .exports()
                .parent_window_app(parent_window)
        },
    );
    // Portal idle inhibitors, to the Wayland thread's idle clock.
    let waking = Arc::clone(&hub);
    hub.portals.hold_idle_through(move |by| {
        waking.send_request(ClientRequest::HeldAwakeByThePortal { by });
    });
    // Browsers' screen wake locks, to the same clock.
    let waking = Arc::clone(&hub);
    screen_saver::serve(in_a_window, move |by, change| {
        waking.send_request(ClientRequest::HeldAwakeByTheScreenSaver { by, change });
    });
    // The chords applications hold, which ride on the portal requests.
    let publishing = Arc::clone(&hub);
    hub.portals.listen_for_shortcuts(move |shortcuts| {
        let told = publishing
            .host
            .lock()
            .unwrap()
            .set_global_shortcuts(shortcuts);
        if let Some(message) = told {
            publishing.broadcast(message);
        }
    });
    // The Wallpaper portal's pictures ride with the dialogs. See `portals`.
    let showing = Arc::clone(&hub);
    hub.portals.show_wallpaper(move |wallpaper| {
        let told = showing.host.lock().unwrap().set_portal_wallpaper(wallpaper);
        if let Some(message) = told {
            showing.broadcast(message);
        }
    });
    // Bind here so a failure ends the run. Nothing can connect yet: the shell
    // waits for the session document, published much later.
    let chrome_listener = bind_chrome_socket(&arguments.chrome_socket)?;
    // Warn if no page connects. Otherwise a desktop with no chrome is just a
    // blank window with healthy-looking logs. Only this side can tell "not yet"
    // from "never". See `domicile_launch::handshake`.
    //
    // Only when `--expect-a-page` is set. Engine spike harnesses use their own
    // `file://` page and never connect here.
    let handshake = Arc::new(Handshake::new());
    {
        let handshake = handshake.clone();
        let socket = arguments.chrome_socket.clone();
        let expected = arguments.expect_a_page;
        thread::spawn(move || {
            thread::sleep(WAIT_FOR_A_PAGE);
            if let Some(said) = silence(expected, handshake.heard(), &socket, WAIT_FOR_A_PAGE) {
                tracing::error!("{said}");
            }
        });
    }
    {
        let hub = hub.clone();
        let handshake = handshake.clone();
        thread::spawn(move || serve_chrome(hub, chrome_listener, handshake));
    }

    {
        let hub = hub.clone();
        thread::spawn(move || serve_outbound(hub, outbound_rx));
    }

    // The renderer imports client dmabufs and reads back shm buffers, which is
    // how client frames reach the engine. Without one no window shows: EGL or
    // the graphics driver did not load, as when the driver needs a newer glibc
    // than Domicile's. That is a bug, so it is an error and the person is told.
    // The dmabuf global is not advertised.
    let mut gpu = match headless_renderer() {
        Ok((renderer, importer)) => Some(Gpu {
            gbm: shm_allocator(&importer),
            importer,
            renderer: Box::new(renderer),
        }),
        Err(err) => {
            tracing::error!(
                ?err,
                "no EGL renderer, so no app window can be shown; the graphics driver's own \
                 error is above"
            );
            hub.notifications
                .get()
                .expect("the notification server is handed to the hub before the renderer starts")
                .warn_that_the_renderer_failed();
            None
        }
    };

    // Casts allocate dmabufs on the render node, through their own libgbm.
    let casting_gpu = gpu.as_ref().and_then(|gpu| {
        gpu.gbm.as_ref()?;
        let node = gpu.importer.node()?.to_path_buf();
        Some(casting::Gpu::new(node, |fourcc| {
            render_modifiers(&gpu.renderer, fourcc)
        }))
    });
    // News from the PipeWire thread.
    let (cast_news, heard_cast_news) = channel::<casting::ToWayland>();
    // Requests for the casts Wayland capture clients take.
    let (screen_copy_requests, heard_screen_copy_requests) = channel::<casting::ToPipewire>();

    // An engine on the CPU shows only 8-bit frames from memory.
    let shm_formats = gpu
        .as_ref()
        .filter(|_| !arguments.software_compositing)
        .map(|gpu| shm_upload::shm_formats(&gpu.renderer))
        .unwrap_or_default();

    let mut dmabuf_state = DmabufState::new();
    // An engine on the CPU shows no dmabuf, so clients are offered only
    // `wl_shm`. Mesa then draws GL clients in memory too.
    let dmabuf_global = gpu
        .as_mut()
        .filter(|_| !arguments.software_compositing)
        .map(|gpu| {
            let importer_device = gpu.importer.main_device();
            let formats: Vec<_> = DmabufImporter::formats(gpu.renderer())
                .into_iter()
                .collect();
            advertise_dmabuf(&mut dmabuf_state, &dh, importer_device, formats)
        });

    // Load the engine if asked. Failure is fatal and names the library:
    // `dlopen` only keeps `cargo build` from needing Chromium, not a license to
    // run without it.
    //
    // Without `--engine-socket` no client window can be shown. That is valid
    // (the e2e checks drive the chrome, input and displays without a
    // Chromium build), but it is logged.
    let engine = match arguments.engine_socket.as_deref() {
        Some(socket) => {
            let session = EngineSession::load(socket)?;
            session.configure_input(&config.input);
            thread_priority::raise_the_engine_thread();
            Some(session)
        }
        None => {
            error!(
                "no --engine-socket, so no client window will be shown: the engine is what puts \
                 one on the page and the copy path that used to draw them here is gone. The \
                 chrome, input and the desktop all work as before"
            );
            None
        }
    };

    // Vendor names for monitors. Without the table, monitors use their EDID
    // codes (`DEL`), which works but is logged once so the short names are
    // explained.
    let vendors = match pnp_ids::read_the_table() {
        Ok(vendors) => vendors,
        Err(why) => {
            warn!(
                %why,
                "monitors will be named the way their EDID spells them — `DEL DELL U3219Q \
                 2ZLS413` rather than `Dell Inc. DELL U3219Q 2ZLS413`. An output.profiles \
                 entry matches either spelling, so a profile written against either one \
                 still applies; set DOMICILE_PNP_IDS to a copy of hwdata's table to get the \
                 longer one back"
            );
            pnp_ids::Vendors::none()
        }
    };

    // A machine without libpam, or a uid with no user, is fatal: a desktop
    // that cannot lock fails open. A missing service is not; see
    // `pam::Pam::undeclared`.
    //
    // Verdicts come back to this loop; see `heard_the_verdict`.
    let pam_confdir = arguments
        .pam_confdir
        .clone()
        .unwrap_or_else(|| PathBuf::from(pam::SERVICES));
    let verifier = pam::for_the_desk(config.lock.service(), &pam_confdir)?;
    // Such a desk does not lock (see `Lock::shut`). Tell the person, not
    // only the log.
    if !verifier.checks_passphrases() {
        hub.notifications
            .get()
            .expect("the notification server is handed to the hub before the lock is made")
            .warn_that_the_desk_does_not_lock();
    }
    let lock = Lock::held_by(Box::new(verifier), move |verdict| {
        verdicts
            .send(verdict)
            .expect("the loop that hears a verdict outlives the lock that asked for one")
    });
    // Give chrome connections the lock state (see `answer_on_the_connection`).
    // Safe to set after connections start: the desktop starts unlocked, and
    // nothing can lock it before the event loop runs.
    hub.lock
        .set(lock.seen())
        .expect("the lock is handed to the hub once, at startup");

    let state = DomicileCompositor {
        compositor_state: CompositorState::new::<DomicileCompositor>(&dh),
        xdg_shell_state: XdgShellState::new::<DomicileCompositor>(&dh),
        xdg_activation_state: XdgActivationState::new::<DomicileCompositor>(&dh),
        _xdg_decoration_state: XdgDecorationState::new::<DomicileCompositor>(&dh),
        kde_decoration_state: KdeDecorationState::new::<DomicileCompositor>(
            &dh,
            KdeDefaultMode::Server,
        ),
        keyboard_shortcuts_inhibit_state: KeyboardShortcutsInhibitState::new::<DomicileCompositor>(
            &dh,
        ),
        shm_state: ShmState::new::<DomicileCompositor>(&dh, shm_formats),
        seat_state,
        data_device_state,
        primary_selection_state,
        ext_data_control_state,
        wlr_data_control_state,
        clipboard: History::default(),
        copying: [Vec::new(), Vec::new()],
        holding: [None, None],
        display_handle: dh.clone(),
        seat,
        output_manager_state,
        outputs,
        config: ConfigStore::new(config.clone()),
        engine_displays: Vec::new(),
        display_overrides: Vec::new(),
        virtual_displays: Vec::new(),
        vendors,
        // Toolkits request cursors by name here, which map onto CSS cursor
        // keywords.
        cursor_shape_state: CursorShapeManagerState::new::<DomicileCompositor>(&dh),
        relative_pointer_state: RelativePointerManagerState::new::<DomicileCompositor>(&dh),
        pointer_constraints_state: PointerConstraintsState::new::<DomicileCompositor>(&dh),
        pointer_constraint_offered: None,
        text_input,
        chrome_editor: None,
        composing: false,
        ime_serial: None,
        dmabuf_state,
        dmabuf_global,
        gpu,
        hub,
        scope_clients: arguments.scope_clients,
        launched: launched.clone(),
        electron_entries: arguments.electron_entries.clone(),
        toplevels: Vec::new(),
        app_bounds: HashMap::new(),
        app_zoom: HashMap::new(),
        gamma: gamma::Ramps::default(),
        night_light: night_light::NightLight::default(),
        night_light_frame_due: false,
        display_colors: color_management::DisplayColors::default(),
        held_frames: HeldFrames::new(),
        suspended: HashSet::new(),
        presentations: Presentations::new(),
        frame_callbacks: FrameCallbacks::new(),
        frame_deadline_armed: false,
        clock: Clock::new(),
        popups: Vec::new(),
        grabbing: Vec::new(),
        subsurfaces: Vec::new(),
        next_subsurface: 0,
        synced_moves: Default::default(),
        pointer_app: None,
        cursor_surface: None,
        pointer_surface: None,
        held_buttons: Vec::new(),
        pinch: None,
        swipe: None,
        touches: None,
        touch_clients: touch::TouchClients::default(),
        captures: None,
        start: Instant::now(),
        last_commit: None,
        pending_key: None,
        latency: None,
        latency_app: None,
        latency_reported: false,
        latency_frame: None,
        shm_refused: OncePerWindow::default(),
        uploads: Uploads::default(),
        software_compositing: arguments.software_compositing,
        engine_takes_input: arguments.engine_takes_input,
        configure_answers: HashMap::new(),
        shown: engine_damage::Shown::default(),
        size_limits: HashMap::new(),
        last_buffers: HashMap::new(),
        unannounced: HashSet::new(),
        by_surface: HashMap::new(),
        first_frame_logged: OncePerWindow::default(),
        last_probe: None,
        probe_refused: HashSet::new(),
        probe_missing: HashSet::new(),
        probe_unreadable: HashSet::new(),
        last_find: None,
        find_since: None,
        probe_boxes: HashMap::new(),
        find_settled: false,
        chrome_toplevel: None,
        chrome_frame_shape: None,
        screens,
        device_pixel_ratio: 1.0,
        modifiers: Held::default(),
        stop: Arc::new(AtomicBool::new(false)),
        engine,
        // Armed below, and re-armed by `rejoin_the_engine`.
        engine_source: None,
        // Set by the first page hello.
        engine_process: None,
        engine_disconnected: false,
        idle: Idle::after(&config.idle, Instant::now()),
        web_agents: crate::web_agents::WebAgents::new({
            let display = socket_name.clone();
            std::sync::Arc::new(move || {
                // Beside the compositor, or from the `PATH`.
                let domicile = std::env::current_exe()
                    .ok()
                    .and_then(|exe| Some(exe.parent()?.join("domicile")))
                    .filter(|binary| binary.exists())
                    .map_or_else(
                        || "domicile".to_string(),
                        |binary| binary.display().to_string(),
                    );
                // Its own name in the journal: what it says is how the relay
                // is going, not the compositor's errors.
                crate::spawning::client_command(
                    &[domicile, "mcp".into(), "--relay".into()],
                    &display,
                    std::env::var_os("LD_LIBRARY_PATH").as_deref(),
                    None,
                    0,
                    None,
                )
                .map(|mut relay| {
                    crate::spawning::own_stream(&mut relay, "domicile-relay");
                    relay
                })
            })
        }),
        display_sleep: crate::display_sleep::DisplaySleep::default(),
        held_by_portal_apps: Vec::new(),
        held_by_screen_saver: Vec::new(),
        // Started below, after the event loop's sources.
        index: None,
        // Armed below by `arm_the_idle_clock`, the same path a reload uses.
        idle_clock: None,
        // Armed when a page watches.
        idle_watch_clock: None,
        // Starts unlocked. Built once, never on reload; see the field.
        lock,
        // Taken by `logind::listen`, below.
        sleep_inhibitor: None,
        pam_confdir,
        turnover: None,
        turnover_deadline: None,
        casting: {
            let mut streams = casting::Streams::new(cast_news, screen_copy_requests, casting_gpu);
            streams.screens(cast_screens, None);
            streams
        },
        hold_deadline: None,
        cast_deadline: None,
        screen_copying: casting::Casting::new(cast_requests.clone()),
        copies: screencopy::Copies::default(),
        foreign_toplevels,
        cast_on_title: std::env::var("DOMICILE_CAST_WINDOW")
            .ok()
            .map(|title| (title, casting::Casting::new(cast_requests.clone()))),
        cast_on_monitor: std::env::var("DOMICILE_CAST_MONITOR")
            .ok()
            .map(|name| (name, casting::Casting::new(cast_requests))),
        cast_test_pattern: std::env::var_os("DOMICILE_CAST_TEST_PATTERN")
            .map(|_| casting::TestPattern::default()),
        loop_handle: event_loop.handle(),
    };

    let mut data = CalloopData { display, state };
    data.state.cast_the_monitor_if_asked();

    // Accept on the sockets bound above.
    let handle = event_loop.handle();
    handle.insert_source(source, move |stream, _, data: &mut CalloopData| {
        accept_app_client(data.display.handle(), stream, None);
    })?;
    handle.insert_source(chrome_source, move |stream, _, data: &mut CalloopData| {
        data.display
            .handle()
            .insert_client(stream, Arc::new(ClientState::chrome()))
            .expect("failed to insert the chrome");
    })?;

    // Dispatch Wayland clients from the event loop, then flush.
    let poll_fd = data.display.backend().poll_fd().try_clone_to_owned()?;
    handle.insert_source(
        Generic::new(poll_fd, Interest::READ, Mode::Level),
        |_, _, data: &mut CalloopData| {
            data.display.dispatch_clients(&mut data.state).unwrap();
            // After the dispatch, when dead clients' objects stop being alive.
            // See `let_go_of_what_the_dead_were_holding`.
            data.state.let_go_of_what_the_dead_were_holding();
            data.display.flush_clients().unwrap();
            Ok(PostAction::Continue)
        },
    )?;

    // The engine's fd, in this loop: the library does its work when dispatched,
    // never on its own threads.
    if let Some(session) = data.state.engine.as_ref() {
        data.state.engine_source = Some(poll_the_engine(&handle, session.fd())?);
    }

    // Test pattern frames, ten a second. See `cast_the_test_pattern`.
    if data.state.cast_test_pattern.is_some() {
        handle.insert_source(Timer::immediate(), |_, _, data: &mut CalloopData| {
            data.state.cast_the_test_pattern();
            TimeoutAction::ToDuration(Duration::from_millis(100))
        })?;
    }

    // The latency run's timer.
    //
    // A loop source, not a loop in the commit callback, so clients get releases
    // and frame callbacks between steps. See `step_the_latency`. Only installed
    // when a run is configured.
    if spike_latency_point().is_some() {
        handle.insert_source(Timer::immediate(), |_, _, data: &mut CalloopData| {
            // Re-arm immediately while there is work; calloop still dispatches
            // the other ready sources each turn. Otherwise wait 1 ms to avoid
            // spinning.
            if data.state.step_the_latency() {
                TimeoutAction::ToInstant(Instant::now())
            } else {
                TimeoutAction::ToDuration(Duration::from_millis(1))
            }
        })?;
    }

    // Build the file index from the home directory on a thread at startup, then
    // keep it updated by a watch.
    //
    // Without `HOME`, `search_files` answers nothing.
    match home_directory() {
        Some(home) => {
            let hub = data.state.hub.clone();
            let omit = config.files.omit.clone();
            let (told, heard) = mpsc::channel();
            data.state.index = Some(told.clone());
            thread::spawn(move || {
                keep_the_index(home, kept_at(), omit, (told, heard), |offered| {
                    // Published only for `search_files`; pages get query
                    // results, never the index.
                    *hub.offered.lock().unwrap() = Some(Arc::new(offered));
                });
            });
        }
        None => error!("no HOME in the environment, so there is no home to index"),
    }

    // The idle timer, only if a timeout is configured. The re-arm interval
    // comes from `Idle::next_check`. Shares `arm_the_idle_clock` with reloads,
    // but a failure here is fatal since nothing is running yet.
    data.state.arm_the_idle_clock()?;

    // Emulated input, served on this thread like the engine's, and handed to
    // the portals that take it.
    let (eis, captures) = eis::serve(&handle)?;
    data.state.captures = Some(captures);
    // The Clipboard portal's requests, handled where the seat lives.
    let (selections, heard_selections) = channel::<Selection>();
    handle.insert_source(heard_selections, |event, _, data: &mut CalloopData| {
        if let ChannelEvent::Msg(selection) = event {
            data.state.select_for_a_portal(selection);
        }
    })?;
    let selections = move |selection| {
        // Fails only once the loop has stopped.
        let _ = selections.send(selection);
    };
    data.state.hub.portals.attach(eis.clone(), selections);
    data.state
        .hub
        .eis
        .set(eis)
        .unwrap_or_else(|_| unreachable!("EIS is served once, at startup"));

    // Chrome requests, handled on the Wayland thread.
    handle.insert_source(request_rx, |event, _, data: &mut CalloopData| {
        if let ChannelEvent::Msg(input) = event {
            data.state.handle_client_request(input);
        }
    })?;

    // Casts, routed and filled on the thread that has the windows.
    handle.insert_source(heard_cast_requests, |event, _, data: &mut CalloopData| {
        if let ChannelEvent::Msg(request) = event {
            data.state.cast_requested(request);
        }
    })?;
    handle.insert_source(heard_cast_news, |event, _, data: &mut CalloopData| {
        if let ChannelEvent::Msg(news) = event {
            data.state.cast_news(news);
        }
    })?;
    handle.insert_source(
        heard_screen_copy_requests,
        |event, _, data: &mut CalloopData| {
            if let ChannelEvent::Msg(request) = event {
                data.state.screen_copy_requested(request);
            }
        },
    )?;

    // Passphrase verdicts, handled on the seat's thread where the lock can
    // open.
    handle.insert_source(heard_verdicts, |event, _, data: &mut CalloopData| {
        if let ChannelEvent::Msg(verdict) = event {
            data.state.heard_the_verdict(verdict);
        }
    })?;

    // Sleep and logind's session lock, which lock the desktop where its lock
    // lives.
    let (logind, heard_logind) = channel::<logind::Logind>();
    handle.insert_source(heard_logind, |event, _, data: &mut CalloopData| {
        if let ChannelEvent::Msg(heard) = event {
            data.state.heard_from_logind(heard);
        }
    })?;
    logind::listen(move |heard| {
        // Fails only once the loop has stopped.
        let _ = logind.send(heard);
    });

    // Watch the config file for reloads.
    //
    // `domicile_config::watch` delivers on a std `mpsc` channel from its own
    // thread; a forwarding thread moves results onto a calloop channel, since
    // the desktop can only change on this thread.
    //
    // A watcher that fails to start is logged and the config stays fixed. No
    // config file means nothing to watch.
    match arguments.config.as_ref() {
        None => debug!("no config file, so the desktop is fixed for this run"),
        Some(path) => match domicile_config::watch(path) {
            Ok(watcher) => {
                let (reload_tx, reload_rx) = channel::<Result<Config, ConfigError>>();
                thread::spawn(move || {
                    // Bind the whole watcher so the closure captures it.
                    // Edition 2021 closures capture only the fields used, so
                    // naming just `watcher.rx` would drop the OS watcher, close
                    // the channel and silently stop reloads. Tested by
                    // `tests/desktop.rs` and `tests/outputs.rs`, among others.
                    let watcher = watcher;
                    // Ends when the watcher is dropped or the event loop is
                    // gone. `watch` sends one result per settled save, so each
                    // is forwarded as it comes.
                    while let Ok(parsed) = watcher.rx.recv() {
                        if reload_tx.send(parsed).is_err() {
                            return;
                        }
                    }
                });
                handle.insert_source(reload_rx, |event, _, data: &mut CalloopData| {
                    let ChannelEvent::Msg(parsed) = event else {
                        return;
                    };
                    // The outgoing config, to compute what changed; see
                    // `Restatement`.
                    let was = data.state.config.current().clone();
                    // A config that fails to parse keeps the live one and is
                    // recorded as the last error.
                    if let Err(err) = data.state.config.apply_watch(parsed) {
                        tracing::error!(%err, "keeping the last config that parsed");
                        return;
                    }
                    // Processes started after the reload get the new one.
                    domicile_host::desk_terminal::set(data.state.config.current().terminal.clone());
                    let restated = Restatement::between(&was, data.state.config.current());
                    let rebuilt = data.state.output_settings().and_then(|output| {
                        data.state.screens.reloaded_into(
                            &output,
                            &data.state.engine_displays,
                            &data.state.vendors,
                            &data.state.virtual_displays,
                        )
                    });
                    match rebuilt {
                        // No change: an undescribed config with no monitors
                        // read. The window controls the desktop, and rebuilding
                        // would undo its negotiated density.
                        Ok(None) => {}
                        Ok(Some(screens)) => {
                            let dh = data.display.handle();
                            data.state.adopt_the_desktop(&dh, screens);
                        }
                        // A profile matches the plugged-in monitors but cannot
                        // be applied. The config is accepted; the current
                        // desktop stays.
                        Err(err) => tracing::error!(
                            %err,
                            "keeping the desktop that is up; the reloaded profile does not \
                             describe one these monitors can make"
                        ),
                    }
                    // Then the rest of the config, after the desktop so scale
                    // is advertised against the settled outputs. Always runs:
                    // even a failed profile may come with keyboard changes.
                    data.state.adopt_the_rest_of_the_config(&restated);
                })?;
            }
            Err(err) => {
                tracing::error!(%err, "not watching the config; its displays are fixed for this run");
            }
        },
    }

    // Publish the session document last. The shell waits for it and treats it
    // as "everything is live", so nothing that can fail may come after it.
    //
    // The sockets were bound earlier, so they are listening when the chrome
    // connects.
    publish(
        &Session {
            protocol: domicile_protocol::PROTOCOL_VERSION,
            chrome_socket: arguments.chrome_socket.clone(),
            wayland_display: socket_name.to_string_lossy().into_owned(),
            chrome_wayland_display: chrome_socket_name.clone(),
        },
        &arguments.session,
    )?;
    // Startup commands, once the desktop is live. Not run on reload; see
    // `StartupConfig`. Not recorded in `launched`: every compositor runs them.
    for command in &config.startup.commands {
        start_client(
            command,
            &socket_name,
            arguments.scope_clients,
            child_nice,
            None,
            None,
        );
    }
    data.state.web_agents.set(config.agents.web);
    for command in &left.lost {
        info!(
            ?command,
            "launching again a client the last compositor's crash took"
        );
        start_client(
            command,
            &socket_name,
            arguments.scope_clients,
            child_nice,
            None,
            launched.as_ref(),
        );
    }

    // Raised last, so the service threads started above stay at the nice
    // value they inherited. Threads this one starts later inherit -8.
    thread_priority::raise_and_say(priority::this_thread(), "wayland");

    // Flush after every loop iteration so events queued while handling input
    // reach clients promptly.
    let stop = data.state.stop.clone();
    let signal = event_loop.get_signal();
    event_loop.run(None, &mut data, move |data| {
        // Before the flush, which delivers the request to the copying client.
        // See `read_what_was_copied`.
        data.state.read_what_was_copied();
        data.state.keep_the_browser_composing();
        let _ = data.display.flush_clients();
        if stop.load(Ordering::SeqCst) {
            signal.stop();
        }
    })?;
    Ok(())
}
