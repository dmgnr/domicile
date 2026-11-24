//! The JSON wire protocol between the Domicile host and the in-page client.
//!
//! `@domicile-desktop/sdk` mirrors these types by hand, so change both in the
//! same PR. Keep this crate serde-only so it stays a portable description of
//! the protocol; the host maps it onto its own scene model.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub mod pinch;
pub mod swipe;
pub mod touch;

/// The protocol version this build speaks.
///
/// Pinned at 1: the host and every chrome are built from the same commit, so
/// their versions cannot differ. Start bumping it when a chrome ships apart
/// from the host. The compatibility rule then has to change in three places:
/// [`negotiate`] here, the engine's welcome check, and `greet` in
/// `domicile-test-chrome`.
///
/// The `#[serde(default)]` attributes below are not a compatibility floor.
/// They let this crate read older messages, such as test fixtures and lines
/// in `wire/host-messages.jsonl`.
pub const PROTOCOL_VERSION: u32 = 1;

/// The physical source of a scroll, matching `wl_pointer.axis_source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerAxisSource {
    Wheel,
    Finger,
    Continuous,
    WheelTilt,
}

/// A passphrase typed at the lock screen.
///
/// A newtype so that its [`Debug`] never prints the secret: a `debug!` of a
/// [`ChromeMessage::Unlock`] must not put the passphrase in the journal. Read
/// it only through [`Passphrase::as_str`]. Serialized as a plain string.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Passphrase(String);

impl Passphrase {
    /// The secret, for the caller that checks it.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for Passphrase {
    fn from(passphrase: &str) -> Passphrase {
        Passphrase(passphrase.to_string())
    }
}

impl From<String> for Passphrase {
    fn from(passphrase: String) -> Passphrase {
        Passphrase(passphrase)
    }
}

/// Prints a placeholder so logs show a redacted value, not an empty one.
impl std::fmt::Debug for Passphrase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Passphrase(<redacted>)")
    }
}

/// One browser profile, in [`HostMessage::BrowserProfiles`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserProfile {
    /// Names its directory: lowercase letters, digits and `-`.
    pub id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    /// Keeps nothing past its last page.
    pub private: bool,
    /// The extension ids it turns on; `None` turns on all of them, or none
    /// for a private profile.
    pub extensions: Option<Vec<String>>,
}

/// One extension's chrome://extensions settings, in
/// [`HostMessage::Extensions`]. Each is left as the user set it when absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionSettings {
    /// Runs on `file://` pages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_access: Option<bool>,
    /// May use `chrome.userScripts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_scripts: Option<bool>,
    /// Which sites it runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_access: Option<SiteAccess>,
}

/// Which sites an extension runs on: a mode, or only the hosts listed (each
/// also as `*.host` for its subdomains).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SiteAccess {
    Mode(SiteAccessMode),
    Sites(Vec<String>),
}

/// [`SiteAccess`] other than a list of sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiteAccessMode {
    /// Only where its action was clicked.
    OnClick,
    /// Everywhere it asks to.
    AllSites,
}

/// Where the pointer is on one browser window's page, in
/// [`ChromeMessage::DeskPointer`]. A cast of the window alone draws it there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PointerOverWindow {
    /// The browser window's id, as the engine lists it.
    pub id: String,
    /// The point as a fraction of the page's size, from its top left.
    pub at: (f64, f64),
}

/// The browser's focused text field, in [`ChromeMessage::TextInput`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextField {
    /// Whether a field that takes text has focus. The rest is unset when not.
    pub enabled: bool,
    /// The text around the cursor, with the cursor and the selection's other
    /// end as byte offsets into it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surrounding: Option<Surrounding>,
    /// `text-input-v3`'s `content_hint` bits and `content_purpose`.
    #[serde(default)]
    pub hint: u32,
    #[serde(default)]
    pub purpose: u32,
    /// The text cursor, `[x, y, width, height]` in desk logical pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<[i32; 4]>,
}

/// The text around a field's cursor, in [`TextField`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Surrounding {
    pub text: String,
    pub cursor: u32,
    pub anchor: u32,
}

/// Text being composed, in [`HostMessage::Composition`]: shown in place,
/// with the cursor from `cursor_begin` to `cursor_end`, byte offsets into
/// `text`. Both `-1` hides the cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preedit {
    pub text: String,
    pub cursor_begin: i32,
    pub cursor_end: i32,
}

/// The pointer the engine draws, in [`ChromeMessage::DeskCursor`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorImage {
    /// In pixels.
    pub size: (u32, u32),
    /// From the top left, in pixels.
    pub hotspot: (i32, i32),
    /// Pixels per logical pixel.
    pub scale: f64,
    /// Premultiplied BGRA, rows top to bottom, padded base64.
    pub bgra: String,
}

/// A cursor a client drew on its own surface, in
/// [`HostMessage::AppCursor`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppCursorImage {
    /// A PNG of the surface's buffer, in padded base64.
    pub png: String,
    /// The point that clicks, from the top left, in logical pixels.
    pub hotspot: (i32, i32),
    /// Buffer pixels per logical pixel: the surface's buffer scale.
    pub scale: i32,
}

/// What a client asked the pointer to do over its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerConstraint {
    /// Keep the pointer where it is; the client reads relative motion.
    Lock,
    /// Keep the pointer inside the window.
    Confine,
}

/// A rectangle of a window's surface, in its surface-local units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Messages sent from the chrome (in-page client) to the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChromeMessage {
    /// First message after connecting; declares the version the chrome speaks.
    ///
    /// `checked` is whether the engine is a checked build (DCHECKs on), which
    /// runs slower and uses more memory than the official build.
    Hello {
        protocol_version: u32,
        checked: bool,
    },

    /// First message from an app's connection, in place of `Hello`.
    ///
    /// The connection may send only [`ChromeMessage::SystemRequest`]s for
    /// files, processes and D-Bus, and hears only their answers. See
    /// `docs/architecture/APP-MODULES.md`.
    AppHello { protocol_version: u32 },

    /// The chrome's `devicePixelRatio`.
    ///
    /// The compositor advertises it as the `wl_output` scale so clients render
    /// at the display's real resolution. Sent on connect and whenever it
    /// changes.
    SetDevicePixelRatio { ratio: f64 },

    /// The chrome's viewport in CSS pixels, which is the desktop's size.
    ///
    /// The compositor cannot see the browser's window, so this is its only
    /// source for the size. Separate from [`ChromeMessage::SetDevicePixelRatio`]
    /// because the two change independently. Sent on connect and on every
    /// resize.
    SetDesktopSize { size: [f64; 2] },

    /// Where the page put an app's window, in desktop CSS pixels.
    ///
    /// The compositor enters the window on the displays it overlaps and gives
    /// it the scale of the one holding most of it. It does not move the
    /// window: the page's layout does that.
    ///
    /// A size with no area is a window the page does not draw. The compositor
    /// sends its frame callbacks once a second and marks it `suspended` until
    /// the next box with an area, or the next `Hello`.
    SetAppBounds {
        app_id: String,
        position: [f64; 2],
        size: [f64; 2],
    },

    /// Request keyboard focus for an app. A popup's id focuses the window
    /// under it, and an open menu keeps the keyboard.
    FocusApp { app_id: String },

    /// Return keyboard focus to the chrome.
    FocusChrome,

    /// Ask the client that owns `app_id` to close it.
    ///
    /// The client may refuse, for example to ask about unsaved work. There is
    /// no direct reply; [`HostMessage::AppClosed`] follows if it closes.
    CloseApp { app_id: String },

    /// Spawn a client process (argv) for a keybinding, the launcher or
    /// `domicile open`.
    ///
    /// The child inherits the compositor's environment, so it connects to
    /// Domicile's Wayland display.
    Spawn { command: Vec<String> },

    /// Start a program (argv) as [`ChromeMessage::Spawn`] does, `argv[0]`
    /// looked up on the compositor's `PATH`. Answered with
    /// [`HostMessage::Executed`] on this connection only. Sent by `domicile
    /// exec` and `domicile open`.
    Exec { command: Vec<String> },

    // Input the chrome captured over an <app> element, for the compositor to
    // inject into the client.
    /// Pointer moved to a surface-local coordinate `(x, y)` over an app.
    ///
    /// `moved` is whether the pointer moved on the screen. The browser also
    /// sends a move under a still pointer after a window changes, which is
    /// nobody at the desk.
    PointerMotion {
        app_id: String,
        x: f64,
        y: f64,
        moved: bool,
    },
    /// The pointer moved by `(dx, dy)` over an app, in its surface-local
    /// units, after the [`ChromeMessage::PointerMotion`] that took it there.
    /// For `zwp_relative_pointer_v1`, which games and VM viewers read.
    ///
    /// The browser sends it only for a hand on the mouse: not for a move under
    /// a still pointer, nor for a shell's pointer warp. `(dx, dy)` is after
    /// pointer acceleration; `(dx_unaccel, dy_unaccel)` is the device's own
    /// motion in the same units. A device that reports no unaccelerated
    /// motion (a nested desktop's host, emulated input) gives the accelerated
    /// deltas for both.
    PointerRelative {
        app_id: String,
        dx: f64,
        dy: f64,
        dx_unaccel: f64,
        dy_unaccel: f64,
    },
    /// The page took or let go of the pointer for a window that asked to lock
    /// or confine it ([`HostMessage::AppPointerConstraint`]).
    ///
    /// `true` once the page holds it: the compositor then tells the client
    /// its pointer is locked or confined. `false` when the page let it go, by
    /// Escape, a focus change or the shell's own choice.
    PointerConstrained { app_id: String, active: bool },
    /// Pointer left an app (focus returns to the chrome).
    PointerLeave { app_id: String },
    /// A touchpad pinch over a native app, with scale relative to its beginning.
    PointerPinch {
        app_id: String,
        #[serde(flatten)]
        pinch: pinch::Pinch,
    },
    /// A touchpad swipe the shell did not bind, for the native app under the
    /// pointer. See [`swipe`].
    PointerSwipe {
        #[serde(flatten)]
        swipe: swipe::Swipe,
    },
    /// A touchpad hold the shell did not bind, for the native app under the
    /// pointer. See [`swipe`].
    PointerHold {
        #[serde(flatten)]
        hold: swipe::Hold,
    },
    /// A finger on a native app. See [`touch::Touch`].
    Touch {
        app_id: String,
        #[serde(flatten)]
        touch: touch::Touch,
    },
    /// Pointer button changed over an app. `button` is a Linux input event code
    /// (e.g. `0x110` = left, `0x111` = right, `0x112` = middle).
    PointerButton {
        app_id: String,
        button: u32,
        pressed: bool,
    },
    /// Scroll over an app. `dx`/`dy` are the continuous distance in
    /// surface-logical units. Wheel events carry 120ths of a detent;
    /// finger and continuous events carry no discrete steps. Each axis can
    /// stop independently while the other continues.
    PointerAxis {
        app_id: String,
        dx: f64,
        dy: f64,
        v120_x: i32,
        v120_y: i32,
        source: PointerAxisSource,
        stop_x: bool,
        stop_y: bool,
    },
    /// Key event destined for the focused app. `keycode` is a Linux evdev code.
    Key {
        app_id: String,
        keycode: u32,
        pressed: bool,
    },

    /// Put an earlier clipboard history entry back on the clipboard.
    ///
    /// Carries the [`ClipboardEntry::id`], not text, so a page can only choose
    /// among existing entries and never write arbitrary clipboard contents.
    /// The compositor owns the resulting selection, so it outlives the client
    /// that first copied it. An unknown id is logged and ignored. See
    /// `domicile_host::clipboard`.
    CopyClipboardEntry { entry: u32 },

    /// Drop a clipboard history entry and its contents.
    ///
    /// Removing the [`ClipboardEntry::current`] entry also empties the
    /// clipboard, so it can no longer be pasted. An unknown id is logged and
    /// ignored. The next [`HostMessage::Clipboard`] leaves the entry out.
    RemoveClipboardEntry { entry: u32 },

    /// The user picked a theme from the shell's toggle or `domicile theme`.
    ///
    /// The compositor applies it to the clients too (see
    /// `domicile_compositor::portals::settings`) and broadcasts
    /// [`HostMessage::Theme`] to every chrome, including the sender, so one
    /// path sets the theme. Not written back to the config file, which is
    /// generated; the change lasts until the desktop restarts.
    SetTheme { theme: Theme },

    /// Report the desk's theme. Answered with [`HostMessage::Theme`] on this
    /// connection only.
    ///
    /// Sent by `domicile theme`, whose connection never says `hello` and so
    /// hears no broadcast.
    WhichTheme,

    /// Report each lit monitor under the names a display profile can call it
    /// by. Answered with [`HostMessage::Monitors`] on this connection only.
    ///
    /// Sent by `domicile-app-host` for Settings, whose connection never says
    /// `hello` and so hears no broadcast.
    WhichMonitors,

    /// Report every display with the names it answers to and whether it is
    /// lit. Answered with [`HostMessage::DisplayList`] on this connection
    /// only. Sent by `domicile list-displays`.
    WhichDisplays,

    /// Report every window, native and browser. Answered with
    /// [`HostMessage::WindowList`] on this connection only. Sent by
    /// `domicile list-windows`.
    WhichWindows,

    /// Report how the desktop is. Answered with [`HostMessage::Status`] on
    /// this connection only. Sent by `domicile status`.
    WhichStatus,

    /// Report the commands the shell's pages run for `domicile send-shell`.
    /// Answered with [`HostMessage::ShellCommandList`] on this connection
    /// only. Sent by `domicile list-shell-commands`.
    WhichShellCommands,

    /// Report the keys and gestures the shell's pages bind. Answered with
    /// [`HostMessage::ShellBindingList`] on this connection only. Sent by
    /// `domicile list-bindings`.
    WhichShellBindings,

    /// Report the keyboards, pointers and touch devices the engine reads.
    /// Answered with [`HostMessage::InputList`] on this connection only. Sent
    /// by `domicile list-inputs`.
    WhichInputs,

    /// Report how long nobody has used the desktop. Answered with
    /// [`HostMessage::IdleTime`] on this connection only. Sent by
    /// `domicile idle-time`.
    WhichIdleTime,

    /// Hear about `topics` on this connection until it closes: each topic's
    /// answer at once ([`HostMessage::WindowList`], [`HostMessage::DisplayList`],
    /// [`HostMessage::InputList`], [`HostMessage::Status`]), then again
    /// whenever it changes. Sent by `domicile subscribe`, whose connection
    /// never says `hello`.
    Watch { topics: Vec<WatchTopic> },

    /// Focus, close or kill the native window `id`, its
    /// `ext-foreign-toplevel-list-v1` identifier as `domicile list-windows`
    /// prints it. Answered with [`HostMessage::WindowActed`] on this
    /// connection only. Sent by `domicile focus-window`, `close-window` and
    /// `kill-window`.
    ActOnWindow { id: String, act: WindowAct },

    /// Write a PNG of the whole desk, or of its `area`, to the absolute path
    /// `file`, shrunk so its longer side is at most `fit` pixels. Answered
    /// with [`HostMessage::DeskShot`] on this connection only. Sent by
    /// `domicile screenshot --fit`.
    ShootDesk {
        file: String,
        fit: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<DeskRect>,
    },

    /// Send `input` to the desk, in order, as one emulated device would; it
    /// lets go of what it held once done. Answered with
    /// [`HostMessage::Emulated`] on this connection only. Sent by `domicile
    /// pointer`, `key` and `type`.
    Emulate { input: Vec<EmulatedInput> },

    /// Change how the monitor `display` is set up until the desktop restarts,
    /// over what its config's profile says, like `swaymsg output`. `display`
    /// is a name `domicile list-displays` prints or a profile matches.
    /// Answered with [`HostMessage::DisplayConfigured`] on this connection
    /// only. Sent by `domicile configure-display`.
    ConfigureDisplay {
        display: String,
        change: DisplayChange,
    },

    /// Log at `levels` until the desktop restarts. They replace the levels
    /// set before; [`LogLevels::default`] goes back to the starting levels.
    /// Answered with [`HostMessage::LogLevelsSet`] on this connection only.
    /// Sent by `domicile set-log-level`.
    SetLogLevels { levels: LogLevels },

    /// This page has captured its old frame for `theme`; the windows may now
    /// switch.
    ///
    /// Sent from the shell's theme wipe, so windows that switch afterward are
    /// not already switched in the captured frame. The compositor waits for
    /// every chrome, or for `domicile_host::theme_turnover::CAPTURE_WITHIN`,
    /// then tells the clients and answers with [`HostMessage::WindowsTheme`].
    /// `theme` lets it ignore a capture for a theme already superseded.
    ThemeCaptured { theme: Theme },

    /// Search the home directory index for `query`. Answered with
    /// [`HostMessage::FoundFiles`].
    ///
    /// Carries no path, so a page cannot choose which directory is read. The
    /// compositor filters the index itself (see `domicile_host::file_search`)
    /// because the index is too large to send to the page.
    SearchFiles { query: String },

    /// Try to unlock the desktop with a passphrase from the lock screen.
    ///
    /// The compositor checks it, not the page, so editing the page cannot
    /// open the lock. The answer is [`HostMessage::Locked`] to every chrome. A
    /// passphrase that did not open it gets `locked: true` again, after a
    /// [`SystemEvent::UnlockRefused`] saying why to every page listening with
    /// [`SystemRequest::UnlockRefusals`].
    Unlock { passphrase: Passphrase },

    /// Lock the desktop now.
    ///
    /// Every chrome receives [`HostMessage::Locked`]. With no passphrase
    /// verifier configured this only logs.
    Lock,

    /// Somebody used the keyboard, pointer or touchpad, wherever it went.
    ///
    /// The browser sends it for its own input, at most every 200 ms. Input to
    /// a browser window or the shell's page reaches the compositor no other
    /// way, and the idle clock must hear it.
    Activity {
        /// What the input was, for the log: the event, and the device it came
        /// from when known, e.g. `"MouseMoved from Logitech USB Receiver"`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
    },

    /// The engine caught itself in a bug: a page it took out of fullscreen
    /// stayed in it, say.
    ///
    /// The compositor logs it as an error and tells the person, with a way to
    /// report it, rather than leaving a broken window unexplained.
    EngineFault {
        /// What went wrong, in a sentence a person can read.
        what: String,
    },

    /// Where the pointer is on the desk, in the shell page's CSS pixels,
    /// which are the desktop's logical pixels, or `None` off it, and each
    /// browser window whose page it is on.
    ///
    /// The browser sends it on each move, wherever the pointer is. Screen
    /// casts draw the pointer from it; the compositor knows it no other way
    /// outside a window.
    DeskPointer {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<(f64, f64)>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        windows: Vec<PointerOverWindow>,
    },

    /// The pointer on screen, or `None` while it is hidden.
    ///
    /// The browser sends it each time the pointer changes, and after `Hello`.
    /// The engine draws the pointer, so screen casts draw it from this; the
    /// compositor has no pointer image of its own.
    DeskCursor {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<CursorImage>,
    },

    /// The browser's focused text field, as an editor for the desk's input
    /// method (`text-input-v3`'s state). Sent whole on every change, and with
    /// `enabled: false` when no field has focus. The browser's own, never the
    /// page's. See `docs/architecture/TEXT-INPUT.md`.
    TextInput { field: TextField },

    /// A key typed into a browser field while the input method composes
    /// ([`HostMessage::InputMethod`]), for the input method to read first.
    /// What it does not take comes back as [`HostMessage::KeyPassed`]. An
    /// evdev code.
    KeyForInputMethod { keycode: u32, pressed: bool },

    /// The page renders `<app frame>`, so the compositor may sync frames
    /// ([`HostMessage::PopupPlaced`]'s `frames`) until the next `Hello`.
    ///
    /// Without it, a page that sets `frame` some other way, such as always 0,
    /// would show a synced window's old frame. See
    /// `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
    SyncFrames,

    /// A click on a system tray icon.
    ///
    /// `id` is a [`TrayItem::id`]. No reply: the application decides what the
    /// click does, and any icon change arrives in the next
    /// [`HostMessage::Tray`]. An unknown id means the application exited while
    /// the click was in flight, and is ignored.
    ActivateTrayItem { id: String, action: TrayAction },

    /// The user dismissed these [`Notification::id`]s.
    ///
    /// One message for any number, so "clear all" is one broadcast. Answered
    /// with the next [`HostMessage::Notifications`]; each application receives
    /// `NotificationClosed` with reason "dismissed by the user". Unknown ids
    /// were closed by their application meanwhile and are ignored.
    DismissNotifications { ids: Vec<u32> },

    /// The user pressed a notification's button, or the notification itself.
    ///
    /// `action` is a [`NotificationAction::key`], or `"default"` for a
    /// [`Notification::clickable`] notification. The application receives
    /// `ActionInvoked`, then the notification closes, as other servers do.
    InvokeNotificationAction { id: u32, action: String },

    /// The user typed `text` into a notification's reply field.
    ///
    /// Only a notification whose actions include `inline-reply` has one. The
    /// application receives `NotificationReplied`, then the notification
    /// closes, as for an action.
    ReplyToNotification { id: u32, text: String },

    /// A call on the system: a file, a directory, a watch or a process.
    ///
    /// `id` is the page's, and names the call in every answer. A watch or a
    /// process keeps its id until [`HostMessage::SystemEnd`], and the page
    /// drives it by sending further requests under the same id. See
    /// `docs/SHELL-SYSTEM-ACCESS.md`.
    SystemRequest { id: u32, request: SystemRequest },

    /// The shell's answer to a [`PortalRequest`].
    ///
    /// The first answer wins; the compositor logs and drops an answer for a
    /// request that is gone. See `domicile_host::portals`.
    AnswerPortalRequest { id: u32, answer: PortalAnswer },
}

/// The process on the far end of a client's connection.
///
/// The kernel records it at `connect(2)` (`SO_PEERCRED`), so the client cannot
/// forge it, unlike its app id or title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub pid: i32,
    pub uid: u32,
    pub gid: u32,
    /// The inode of the process's pidfd, which no other process gets while
    /// the system is up, so it tells a reused pid apart. `None` on kernels
    /// without pidfs (before Linux 6.9).
    pub pidfd_inode: Option<u64>,
    /// The sandbox the client connected from, through a
    /// `wp_security_context_v1` listener; `None` for an unsandboxed client.
    pub sandbox: Option<Sandbox>,
}

/// What a sandbox engine said about a client when it created its
/// `wp_security_context_v1`. Each is `None` when the engine did not say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sandbox {
    /// The sandbox engine, such as `org.flatpak`.
    pub engine: Option<String>,
    /// The engine's id for the application.
    pub app_id: Option<String>,
    /// The engine's id for this instance of the application.
    pub instance_id: Option<String>,
}

/// A surface's synced frame: the page shows `app_id` at `frame` once its
/// `<app frame>` says so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppFrame {
    pub app_id: String,
    pub frame: u32,
}

/// Frame 0 is every surface's first, so the wire leaves it out.
fn is_frame_zero(frame: &u32) -> bool {
    *frame == 0
}

/// Messages sent from the host to the chrome (in-page client).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMessage {
    /// Response to `Hello`; declares the version the host agreed to speak.
    Welcome { protocol_version: u32 },

    /// Which modifier keys are held, sent whenever that changes.
    ///
    /// The chrome loses `wl_keyboard.modifiers` once a window has focus, but
    /// still needs them, for example for Alt-drag. Only modifiers are
    /// reported, never other keys. A newly connected chrome is not caught up.
    /// The focused client still receives the keys.
    Modifiers {
        alt: bool,
        ctrl: bool,
        shift: bool,
        logo: bool,
    },

    /// A Wayland toplevel drew its first frame; the chrome decides where to
    /// mount its `<app id="…">` element.
    ///
    /// Sent at the first buffer commit, so it carries everything the client
    /// set before drawing. Later changes follow in their own messages.
    AppAppeared {
        app_id: String,
        title: Option<String>,
        /// The client's `xdg_toplevel.set_app_id`, which names its desktop
        /// entry. Absent when the client set none; a later one follows in
        /// [`HostMessage::AppDesktopId`].
        desktop_id: Option<String>,
        /// The size the client drew its first frame at, logical.
        size: [f64; 2],
        /// The client marked the window a dialog: it has a parent
        /// (`xdg_toplevel.set_parent`) or a fixed size, as sway reads them.
        /// Shells float dialogs at `size`.
        dialog: bool,
        /// The client asked to draw its own frame (client-side decorations).
        /// The compositor still answers "server side"; a shell can leave its
        /// own frame off such a window where that suits it.
        client_frame: bool,
        /// The process that connected the window's client.
        owner: Owner,
        /// The window's identifier on `ext-foreign-toplevel-list-v1`, which a
        /// capture tool such as `grim -T` takes to name it. Fixed for the
        /// window's life.
        toplevel_id: String,
        /// The window's synced frame, for a page that renders `<app frame>`.
        /// Above 0 only for a window that appeared before this page did. See
        /// `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
        #[serde(default, skip_serializing_if = "is_frame_zero")]
        frame: u32,
    },

    /// Each browser window's identifier on `ext-foreign-toplevel-list-v1`, by
    /// the engine's window id, as [`HostMessage::AppAppeared`] carries a
    /// native window's.
    ///
    /// Sent whenever the browser windows change, and after `welcome`. Latest
    /// wins.
    BrowserToplevelIds {
        toplevel_ids: BTreeMap<String, String>,
    },

    /// A window's title, sent whenever it changes.
    ///
    /// Sent only after [`HostMessage::AppAppeared`], which carries the title
    /// set before the first frame. `title` is optional only to match
    /// `AppAppeared`; xdg-shell cannot unset a title, so this never sends
    /// `None`. The chrome treats `""` as no title.
    AppTitled {
        app_id: String,
        title: Option<String>,
    },

    /// A window's desktop id (`xdg_toplevel.set_app_id`), sent whenever it
    /// changes.
    ///
    /// Sent only after [`HostMessage::AppAppeared`], as
    /// [`HostMessage::AppTitled`] is. xdg-shell cannot unset an app id, so
    /// this always carries one.
    AppDesktopId { app_id: String, desktop_id: String },

    /// A client's content size changed, in logical units (CSS pixels, as
    /// `wl_pointer` uses), not buffer pixels.
    AppResized { app_id: String, size: [f64; 2] },

    /// A client opened or moved a popup, such as a menu, a tooltip, a
    /// bubble drawn as a subsurface (Chromium's extension popups) or an input
    /// method's candidate list (over the window being typed in).
    ///
    /// The popup is its own `<app>`, positioned rather than laid out:
    /// `position` is its top-left relative to `parent`, and `size` its box,
    /// both logical. `parent` is a window or popup announced earlier. Closed
    /// with [`HostMessage::AppClosed`]. Shells must not treat a popup as a
    /// window: it has no title, focus or tiling. `grab` marks a menu that
    /// should close when a press lands elsewhere.
    ///
    /// `frames` names the synced frame of each surface the move goes with: a
    /// page that renders `<app frame>` sets them in the same update as the
    /// move. See `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
    PopupPlaced {
        app_id: String,
        parent: String,
        position: [f64; 2],
        size: [f64; 2],
        grab: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        frames: Vec<AppFrame>,
    },
    /// A window's minimum size in logical units (`xdg_toplevel.set_min_size`).
    ///
    /// `0` on an axis means no limit. The compositor crops windows sized below
    /// this, so shells should respect it. Sent right after
    /// [`HostMessage::AppAppeared`], then only when it changes.
    AppMinSize { app_id: String, size: [f64; 2] },

    /// A window's maximum size (`xdg_toplevel.set_max_size`), read as
    /// [`HostMessage::AppMinSize`] is.
    AppMaxSize { app_id: String, size: [f64; 2] },

    /// A client went away; the chrome should unmount its `<app>` element.
    AppClosed { app_id: String },

    /// The cursor a client asked for over its surface, for the chrome to apply
    /// to the app's element.
    ///
    /// `image` is a cursor the client drew itself, which a game, image editor
    /// or VM viewer does. `cursor` is then [`CursorShape::Default`], which an
    /// engine that does not read `image` shows instead.
    AppCursor {
        app_id: String,
        cursor: CursorShape,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image: Option<AppCursorImage>,
    },

    /// The window under the pointer asked to lock the pointer in place or
    /// confine it to the window (`zwp_pointer_constraints_v1`), or `None` once
    /// that ask ended: the client withdrew it or the pointer left the window.
    ///
    /// Only the window under the pointer is offered one. The page answers
    /// with [`ChromeMessage::PointerConstrained`].
    ///
    /// `region` is the part of the window the constraint holds, as
    /// non-overlapping rectangles of its surface; `None` for the whole
    /// window, and always `None` with no constraint. A confined pointer stays
    /// inside it; a lock begins only inside it.
    AppPointerConstraint {
        app_id: String,
        constraint: Option<PointerConstraint>,
        region: Option<Vec<SurfaceRect>>,
    },

    /// A window or popup reached the screen: viz showed its first frame, or
    /// the first frame its client drew after a configure changed its size.
    ///
    /// Sent once for each. A move, a configure at the same size and a hidden
    /// window shown again send nothing.
    AppPresented { app_id: String },

    /// The compositor marked a window `suspended` (`xdg_toplevel`), or cleared
    /// it.
    ///
    /// A window is suspended while the page reports it hidden
    /// ([`ChromeMessage::SetAppBounds`] with no area) and no cast shows it.
    /// Sent on each change.
    AppSuspended { app_id: String, suspended: bool },

    /// The window a toplevel is a dialog for (`xdg_toplevel.set_parent`), or
    /// `None` for none, sent whenever it changes.
    ///
    /// Sent right after [`HostMessage::AppAppeared`] when set before the first
    /// frame. When the parent closes, its children take its own parent, as
    /// xdg-shell says.
    AppTransientFor {
        app_id: String,
        transient_for: Option<String>,
    },

    /// The page anchor a window asked to be laid out at
    /// (`domicile_toplevel_anchor_v1.set_anchor`), or `None` for none, sent
    /// whenever it changes.
    ///
    /// Sent right after [`HostMessage::AppAppeared`] when set before the first
    /// frame. The name means what the shell says it does; a shell with no
    /// anchor of that name lays the window out as any other. See
    /// `docs/architecture/WINDOW-COMPOSITING.md#anchored-windows`.
    AppAnchored {
        app_id: String,
        anchor: Option<String>,
    },

    /// Whether a window wants attention, sent whenever that changes.
    ///
    /// Set when the compositor drops the window's `xdg-activation` request
    /// (see [`HostMessage::FocusRequested`]), unless it holds the keyboard.
    /// Cleared when it gets the keyboard. Sent right after
    /// [`HostMessage::AppAppeared`] when set.
    AppUrgent { app_id: String, urgent: bool },

    /// Whether a window holds an active `zwp_keyboard_shortcuts_inhibitor_v1`.
    ///
    /// While it has the keyboard, the desktop's shortcuts are its keys: the
    /// engine lets grabbed chords through to it, and a shell's own listeners
    /// should too. Sent after [`HostMessage::AppAppeared`] when the window
    /// holds one, then on each change.
    AppInhibitsShortcuts { app_id: String, inhibits: bool },

    /// The desktop's displays, as regions of the single chrome page.
    ///
    /// Sent after `welcome` and whenever the layout changes. Latest wins; a
    /// broadcast can reach a connection before its `welcome`. The compositor
    /// always sends at least one display. An empty list comes only from a
    /// host with no desktop described, such as unit tests or the `domicile`
    /// daemon.
    Displays { displays: Vec<DisplayInfo> },

    /// Each lit monitor, under the names a display profile can call it by.
    /// Answers [`ChromeMessage::WhichMonitors`] on the asking connection
    /// only, so Settings can offer HDR only where a monitor takes it.
    Monitors { monitors: Vec<MonitorInfo> },

    /// Answers [`ChromeMessage::WhichDisplays`] on the asking connection only.
    DisplayList { displays: Vec<ListedDisplay> },

    /// Answers [`ChromeMessage::WhichWindows`] on the asking connection only.
    /// Native windows first, in the order they opened, then browser windows.
    WindowList { windows: Vec<ListedWindow> },

    /// Answers [`ChromeMessage::WhichStatus`] on the asking connection only.
    Status(DesktopStatus),

    /// Answers [`ChromeMessage::WhichShellCommands`] on the asking connection
    /// only: what each listening page said it runs, once each, in the order
    /// the pages started listening.
    ShellCommandList { commands: Vec<ShellCommandHelp> },

    /// Answers [`ChromeMessage::WhichShellBindings`] on the asking connection
    /// only: each listening page's bindings, in the order the pages started
    /// listening.
    ShellBindingList { bindings: Vec<ShellBinding> },

    /// Answers [`ChromeMessage::WhichInputs`] on the asking connection only,
    /// in the order the engine found the devices.
    InputList { inputs: Vec<ListedInput> },

    /// Answers [`ChromeMessage::WhichIdleTime`] on the asking connection only:
    /// whole seconds since the last input from a keyboard, pointer, touch or
    /// tablet, or since the compositor started when there has been none. Idle
    /// inhibitors don't reset it, as they don't reset Electron's
    /// `powerMonitor.getSystemIdleTime`.
    IdleTime { seconds: u64 },

    /// Answers [`ChromeMessage::ActOnWindow`] on the asking connection only:
    /// why it was not done, or nothing when it was.
    WindowActed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refused: Option<String>,
    },

    /// Answers [`ChromeMessage::ConfigureDisplay`] on the asking connection
    /// only: why it was not done, or nothing when the desktop took it.
    DisplayConfigured {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refused: Option<String>,
    },

    /// Answers [`ChromeMessage::SetLogLevels`] on the asking connection only:
    /// why they were not set, or nothing.
    LogLevelsSet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refused: Option<String>,
    },

    /// Answers [`ChromeMessage::ShootDesk`] on the asking connection only:
    /// what the PNG shows, or why there is none.
    DeskShot {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shot: Option<DeskShot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refused: Option<String>,
    },

    /// Answers [`ChromeMessage::Exec`] on the asking connection only: why
    /// the program did not start, or nothing when it did.
    Executed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refused: Option<String>,
    },

    /// Answers [`ChromeMessage::Emulate`] on the asking connection only: why
    /// it was not sent, or nothing when it was.
    Emulated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refused: Option<String>,
    },

    /// The compositor's compiled keymap, in `XKB_KEYMAP_FORMAT_TEXT_V1`.
    ///
    /// Read by the browser process and never forwarded to the page. Off
    /// ChromeOS, Chromium's DRM/Ozone build never sets a keymap, so typing
    /// into the shell produces no characters. Sending the compiled text, not
    /// the XKB config, keeps one source for the layout. Sent with the
    /// handshake so a reloaded page gets it again.
    Keymap { keymap: String },

    /// Whether the browser's keys go to the input method first
    /// ([`ChromeMessage::KeyForInputMethod`]): an input method holds the
    /// keyboard, a browser field is the editor, and the desk is unlocked.
    /// Read by the browser process and never forwarded to the page. Sent on
    /// every change. See `docs/architecture/TEXT-INPUT.md`.
    InputMethod { composing: bool },

    /// What the input method did to the browser's focused field, applied
    /// together: delete around the cursor, then commit, then show the preedit
    /// (`text-input-v3`'s `done`). Read by the browser process and never
    /// forwarded to the page.
    ///
    /// `serial` grows with each composition or passed key, across compositor
    /// restarts, so a browser hearing it on several connections applies it
    /// once.
    Composition {
        serial: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preedit: Option<Preedit>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
        /// Bytes before and after the cursor, in the field's UTF-8 text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delete: Option<[u32; 2]>,
    },

    /// A key from [`ChromeMessage::KeyForInputMethod`] the input method passed
    /// on uncomposed, for the browser to type as it would have. `serial` as in
    /// [`HostMessage::Composition`].
    KeyPassed {
        serial: u64,
        keycode: u32,
        pressed: bool,
    },

    /// The Chrome extensions to install into the browser windows' profile. See
    /// `docs/architecture/EXTENSIONS.md`.
    ///
    /// `web_store` holds Chrome Web Store ids; `unpacked` holds absolute paths
    /// to unpacked extension directories; `settings` holds each extension's
    /// chrome://extensions settings by id. Always the full list: the browser
    /// removes what it installed and the list no longer names, and puts back
    /// Chrome's default for a setting it no longer names. Sent with the
    /// handshake and on reloads that change it. Not sent when nothing is
    /// configured, because an empty list uninstalls everything.
    Extensions {
        web_store: Vec<String>,
        unpacked: Vec<String>,
        settings: BTreeMap<String, ExtensionSettings>,
    },

    /// The browser profiles and the profile each site opens in: the config's
    /// `browser`. See `docs/architecture/BROWSER-PROFILES.md`.
    ///
    /// Always the full set. Sent with the handshake and on reloads that
    /// change it. Not sent by a host without a config, whose browser keeps
    /// one profile and its private one.
    BrowserProfiles {
        profiles: Vec<BrowserProfile>,
        default_profile: String,
        default_private_profile: String,
        /// Profile ids by site: a host, `*.host`, or a host and path.
        sites: BTreeMap<String, String>,
    },

    /// The config's `spellcheck`: whether the browser checks spelling in
    /// pages' text fields, and in which languages. Sent with the handshake and
    /// on reloads that change it.
    Spellcheck {
        enabled: bool,
        languages: Vec<String>,
    },

    /// Host names of sites the browser draws dark while the theme is dark.
    ///
    /// The config's `theme.force_dark`. Always the full list. Sent with the
    /// handshake and on reloads that change it.
    ForceDark { sites: Vec<String> },

    /// Who holds the keyboard: an app, or the chrome (`None`).
    ///
    /// Focus also moves without `focus_app`, for example on a click or when a
    /// focused client exits. Sent to every chrome on each change, and with the
    /// catch-up a newly connected chrome receives.
    FocusChanged {
        /// `None` means the chrome holds the keyboard.
        app_id: Option<String>,
    },

    /// A client asked for keyboard focus; nothing has moved yet.
    ///
    /// The shell decides: it answers with `focus_app` or ignores the request,
    /// so it can stop windows stealing focus. Clients ask through
    /// `xdg-activation`. Not sent for clicks, which the page handles itself;
    /// see `APP_FOCUS_REQUESTED_EVENT` in `@domicile-desktop/sdk`.
    FocusRequested { app_id: String },

    /// The results of a [`ChromeMessage::SearchFiles`].
    ///
    /// `query` echoes the request so a shell can drop stale answers. `files`
    /// holds the first matches as paths relative to home, in byte order, with
    /// directories ending in `/`; pass one to `spawn` unchanged. `matched` is
    /// the total count.
    ///
    /// `indexing` is true while the index is still being built. The shell
    /// must not treat missing results as absent files then, and should ask
    /// again; see `packages/shell-manganese`'s launcher.
    FoundFiles {
        query: String,
        files: Vec<String>,
        matched: u32,
        indexing: bool,
    },

    /// The clipboard history, newest first.
    ///
    /// Only the compositor sees `wl_data_device.set_selection`, and a
    /// selection normally dies with its client, so the history lives here.
    /// Pushed on every change and on connect.
    ///
    /// Entries carry previews, not full contents, to limit what reaches the
    /// page (copied passwords included); [`ChromeMessage::CopyClipboardEntry`]
    /// restores the full text. Text selections only. The history is in memory
    /// only, so it starts empty.
    Clipboard { entries: Vec<ClipboardEntry> },

    /// The desktop's current theme.
    ///
    /// Sent on connect, when a config reload changes `theme`, and to every
    /// chrome after [`ChromeMessage::SetTheme`]. There is no "follow the
    /// system" value because Domicile is the system; see
    /// [`domicile_config::ThemeMode`].
    Theme { theme: Theme },
    /// Whether the desktop is idle.
    ///
    /// `true` after `idle.blank_after_seconds` without input; `false` when
    /// input resumes. Decided by `crate::idle` in `domicile-compositor`.
    /// Sent on each change and on connect, so a reloaded page knows the state.
    ///
    /// It goes out with the blanking modeset, not before it. Use it to
    /// prepare what shows when the screens return. A shell that acts sooner
    /// listens with [`SystemRequest::IdleBeforeBlanking`].
    ///
    /// Not sent at all when blanking is not configured. Idle is not locked;
    /// see [`HostMessage::Locked`].
    Idle { idle: bool },

    /// Whether the desktop is locked.
    ///
    /// While `true`, the compositor drops all forwarded input instead of
    /// injecting it (see `crate::lock` in `domicile-compositor`), so a page
    /// reload, an engine crash or an edited shell cannot unlock it. The page
    /// still receives its own keys, which is how it collects the passphrase
    /// for [`ChromeMessage::Unlock`]. Sent on each change and on connect.
    Locked { locked: bool },

    /// The theme the windows now use.
    ///
    /// The second half of [`HostMessage::Theme`]. Windows switch once every
    /// chrome has sent [`ChromeMessage::ThemeCaptured`]; this is sent after
    /// they had a chance to repaint, or after
    /// `domicile_host::theme_turnover::REPAINT_WITHIN`. The browser process
    /// uses it for its own pages, and the shell ends its wipe on it. Also sent
    /// on connect.
    WindowsTheme { theme: Theme },

    /// The config's accent color, contrast and reduced motion, for the shell
    /// to follow as the Settings portal's clients do, and its pointer theme,
    /// for the browser process. Sent on connect and when a reload changes it.
    Appearance(Appearance),

    /// Every system tray icon, in registration order.
    ///
    /// The compositor is the StatusNotifierItem host on the session bus; see
    /// `crate::tray` in `domicile-compositor`. Pushed as the full list on any
    /// change and on connect. Items whose status is `Passive` are omitted, as
    /// every tray does.
    Tray { items: Vec<TrayItem> },

    /// Every notification not yet dismissed, oldest first.
    ///
    /// The compositor is the `org.freedesktop.Notifications` server, which
    /// also receives Chrome's Web Notifications; see `crate::notifications`
    /// in `domicile-compositor`. Pushed as the full list on any change and on
    /// connect. The shell works out which are new.
    Notifications { items: Vec<Notification> },

    /// What the config says to the shell: the evdev key for each keysym name
    /// the keyboard can type, and the values of the shell's options.
    ///
    /// Shells bind chords by keysym, but presses arrive as keys, and only the
    /// compositor has the keymap. See the SDK's `bindKeys`. `options` is the
    /// config's `shell_options` as JSON text, which the compositor does not
    /// read; see the SDK's `watchShellOptions`. Sent on connect and when a
    /// reload changes either.
    ShellConfig {
        keys: BTreeMap<String, u32>,
        options: String,
    },

    /// The answer to a [`ChromeMessage::SystemRequest`]. Every call that
    /// starts something gets exactly one.
    SystemReply { id: u32, reply: SystemReply },

    /// Something a running watch or process produced.
    SystemEvent { id: u32, event: SystemEvent },

    /// A watch or process is over. The last message under its `id`.
    SystemEnd { id: u32, end: SystemEnd },

    /// Every portal dialog not yet answered, oldest first.
    ///
    /// The compositor is the `xdg-desktop-portal` backend; see
    /// `docs/PORTALS.md`. Pushed as the full list on any change
    /// and on connect, so a reloaded page still sees a pending dialog. The
    /// shell answers with [`ChromeMessage::AnswerPortalRequest`].
    ///
    /// `capturing` lists the sessions that record the screen or control or
    /// capture input, so the shell can show each one and stop it with
    /// [`PortalAnswer::Stop`].
    /// `shortcuts` lists the chords applications hold through the
    /// GlobalShortcuts portal. The shell grabs each and sends
    /// [`PortalAnswer::Pressed`] under its id when it fires, and
    /// [`PortalAnswer::Released`] when it is let go.
    PortalRequests {
        items: Vec<PortalRequest>,
        #[serde(default)]
        capturing: Vec<Capturing>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        shortcuts: Vec<BoundShortcut>,
        /// The pictures applications set through the Wallpaper portal, for the
        /// shell to draw.
        #[serde(default, skip_serializing_if = "PortalWallpaper::is_unset")]
        wallpaper: PortalWallpaper,
    },
}

/// The pictures applications set through the Wallpaper portal, as absolute
/// paths the shell reads with `read_file`. Absent where none was set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalWallpaper {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lockscreen: Option<String>,
}

impl PortalWallpaper {
    /// Whether no picture was set anywhere.
    pub fn is_unset(&self) -> bool {
        self.background.is_none() && self.lockscreen.is_none()
    }
}

/// The config's `theme` keys besides `mode`, which the Settings portal also
/// serves applications in `org.freedesktop.appearance`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Appearance {
    /// `"#rrggbb"`, or absent to keep the shell's own accent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    pub high_contrast: bool,
    pub reduced_motion: bool,
    /// The XCursor theme the browser process draws the pointer from, or
    /// absent for Chromium's own art. The page never sees it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CursorTheme>,
    /// When the browser process hides the pointer, or absent to never hide
    /// it. The page never sees it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_hiding: Option<CursorHiding>,
}

/// When the pointer is hidden. It shows again on the next pointer input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorHiding {
    /// Milliseconds without pointer input, or absent for no timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_ms: Option<u32>,
    /// Whether a typing key press hides it.
    pub when_typing: bool,
}

/// An XCursor theme at a size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorTheme {
    /// The theme's directory name, such as `Adwaita`.
    pub name: String,
    /// In logical pixels.
    pub size: u16,
}

/// A dialog an application asked for through a portal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalRequest {
    /// The id [`ChromeMessage::AnswerPortalRequest`] uses. Never reused.
    pub id: u32,
    /// The asking application's desktop file id, as the portal frontend
    /// names it. Empty for an application it could not identify.
    pub app_id: String,
    /// The `<app>` the dialog is modal over, or absent to put it over the
    /// focused screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_app_id: Option<String>,
    /// What the dialog asks.
    #[serde(flatten)]
    pub kind: PortalKind,
}

/// What a [`PortalRequest`] asks, as `kind` and `body` on the wire.
///
/// The engine relays `body` without reading it; the SDK parses it per kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "body", rename_all = "snake_case")]
pub enum PortalKind {
    /// `org.freedesktop.impl.portal.Access`: allow or deny.
    Access(AccessDialog),
    /// `org.freedesktop.impl.portal.AppChooser`: pick an application to open
    /// a file or URI with. `OpenURI` asks through it too.
    AppChooser(AppChooserDialog),
    /// `org.freedesktop.impl.portal.FileChooser`: pick files to open or a
    /// place to save.
    FileChooser(FileChooserDialog),
    /// `org.freedesktop.impl.portal.Inhibit`: an application holding off
    /// logout, user switching or suspend, so a shell can say who. Listed
    /// until the application lets go. Not a dialog: it accepts no answer.
    Inhibit(Inhibition),
    /// `org.freedesktop.impl.portal.RemoteDesktop`'s `Start`: which devices,
    /// and the clipboard, an application may control.
    RemoteDesktop(RemoteDesktopDialog),
    /// `org.freedesktop.impl.portal.InputCapture`'s `CreateSession`: whether
    /// an application may take the input it names.
    InputCapture(InputCaptureDialog),
    /// `org.freedesktop.impl.portal.Account`: share the user's name and
    /// picture, or not. Allowed with [`PortalAnswer::Access`].
    Account(AccountDialog),
    /// `org.freedesktop.impl.portal.GlobalShortcuts`: review the chords an
    /// application asks for.
    GlobalShortcuts(ShortcutsDialog),
    /// `org.freedesktop.impl.portal.Wallpaper`: a picture to preview before it
    /// is set. Allowed with [`PortalAnswer::Access`].
    Wallpaper(WallpaperDialog),
    /// `org.freedesktop.impl.portal.DynamicLauncher`: confirm installing a
    /// launcher, perhaps under another name.
    DynamicLauncher(LauncherDialog),
    /// `org.freedesktop.impl.portal.Usb`: let an application open USB
    /// devices. Allowed whole with [`PortalAnswer::Access`].
    Usb(UsbDialog),
    /// `org.freedesktop.impl.portal.ScreenCast`: pick what to share.
    ScreenCast(ScreenCastDialog),
    /// `org.freedesktop.impl.portal.Print`: pick a printer and its options.
    Print(PrintDialog),
    /// `org.freedesktop.impl.portal.Screenshot`'s interactive `Screenshot`:
    /// pick the area of a frozen desk to keep.
    Screenshot(FrozenDesk),
    /// `org.freedesktop.impl.portal.Screenshot`'s `PickColor`: pick a pixel
    /// of a frozen desk.
    PickColor(FrozenDesk),
    /// An agent, such as one connected through `domicile mcp`, asks to see
    /// and use the desk: all of it, or only some windows. Domicile's own, not
    /// a portal's. Allowed with [`PortalAnswer::Agent`].
    Agent(AgentDialog),
}

impl PortalKind {
    /// Whether `answer` can answer a request of this kind: its own kind, or a
    /// dismissal or refusal. A chosen application or printer must be one
    /// offered, a print job needs a copy and real pages, and a PDF an
    /// absolute path. An inhibitor takes none.
    pub fn accepts(&self, answer: &PortalAnswer) -> bool {
        match (self, answer) {
            (PortalKind::Inhibit(_), _) => false,
            (_, PortalAnswer::Canceled | PortalAnswer::Refused) => true,
            (
                PortalKind::Access(_)
                | PortalKind::Account(_)
                | PortalKind::Wallpaper(_)
                | PortalKind::Usb(_),
                PortalAnswer::Access,
            ) => true,
            (PortalKind::DynamicLauncher(dialog), PortalAnswer::DynamicLauncher { name }) => {
                !name.is_empty() && (dialog.editable_name || *name == dialog.name)
            }
            (PortalKind::AppChooser(dialog), PortalAnswer::AppChooser { choice }) => {
                dialog.choices.contains(choice)
            }
            (PortalKind::FileChooser(_), PortalAnswer::FileChooser(_)) => true,
            (PortalKind::RemoteDesktop(_), PortalAnswer::RemoteDesktop { .. }) => true,
            (PortalKind::InputCapture(_), PortalAnswer::InputCapture) => true,
            (PortalKind::GlobalShortcuts(_), PortalAnswer::GlobalShortcuts { .. }) => true,
            (PortalKind::ScreenCast(_), PortalAnswer::ScreenCast { .. }) => true,
            (PortalKind::Print(dialog), PortalAnswer::Print { printer, options }) => {
                dialog
                    .printers
                    .iter()
                    .any(|offered| &offered.name == printer)
                    && options.copies >= 1
                    && real_pages(options)
            }
            (PortalKind::Print(_), PortalAnswer::SaveToPdf { path, options }) => {
                path.starts_with('/') && real_pages(options)
            }
            (PortalKind::Screenshot(desk), PortalAnswer::Screenshot { area, .. }) => {
                desk.holds(area)
            }
            (PortalKind::Screenshot(desk), PortalAnswer::ScreenshotWindow { id, .. }) => {
                desk.windows.iter().any(|window| window.id == *id)
            }
            // The engine owns the browser window list, and refuses an id no
            // window has.
            (PortalKind::Screenshot(_), PortalAnswer::ScreenshotBrowserWindow { .. }) => true,
            (PortalKind::PickColor(desk), PortalAnswer::PickColor { x, y }) => {
                *x < desk.width && *y < desk.height
            }
            // Only the whole desk is remembered: window ids last as long as
            // their windows.
            (PortalKind::Agent(_), PortalAnswer::Agent { reach, remember }) => match reach {
                AgentReach::Desk => true,
                AgentReach::Windows { windows } => !windows.is_empty() && !remember,
            },
            // A stop, pause, resume or discard answers a running session and
            // a press or release a bound shortcut, never a request.
            (
                _,
                PortalAnswer::Access
                | PortalAnswer::AppChooser { .. }
                | PortalAnswer::FileChooser(_)
                | PortalAnswer::RemoteDesktop { .. }
                | PortalAnswer::InputCapture
                | PortalAnswer::GlobalShortcuts { .. }
                | PortalAnswer::DynamicLauncher { .. }
                | PortalAnswer::ScreenCast { .. }
                | PortalAnswer::Print { .. }
                | PortalAnswer::SaveToPdf { .. }
                | PortalAnswer::Screenshot { .. }
                | PortalAnswer::ScreenshotWindow { .. }
                | PortalAnswer::ScreenshotBrowserWindow { .. }
                | PortalAnswer::PickColor { .. }
                | PortalAnswer::Agent { .. }
                | PortalAnswer::Stop
                | PortalAnswer::Change
                | PortalAnswer::Pause
                | PortalAnswer::Resume
                | PortalAnswer::Discard
                | PortalAnswer::Pressed
                | PortalAnswer::Released,
            ) => false,
        }
    }
}

/// Whether each of `options`' page ranges counts from 1 and runs forward.
fn real_pages(options: &PrintOptions) -> bool {
    options
        .pages
        .iter()
        .all(|range| 1 <= range.first && range.first <= range.last)
}

/// A `PrepareInstall`: the launcher an application would install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherDialog {
    /// The application's suggested name.
    pub name: String,
    /// The icon, as a `data:` URL; absent when it is no picture a page draws.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub launcher_type: LauncherType,
    /// A web app's address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Whether the user may rename it.
    pub editable_name: bool,
}

/// What a launcher starts: the portal's `launcher_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherType {
    Application,
    Webapp,
}

/// An `AcquireDevices`: the devices an application would open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsbDialog {
    pub devices: Vec<UsbDevice>,
}

/// One USB device, named as udev names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsbDevice {
    /// The frontend's id for it.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    /// Whether the application would write to it.
    pub writable: bool,
}

/// A `SetWallpaperURI` with `show-preview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WallpaperDialog {
    /// The picture, as an absolute path the shell reads with `read_file`.
    pub path: String,
    pub set_on: WallpaperTarget,
}

/// Where a Wallpaper portal picture goes: the portal's `set-on`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WallpaperTarget {
    Background,
    Lockscreen,
    Both,
}

/// What an application's inhibitor holds off, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inhibition {
    /// Never empty.
    pub what: Vec<Inhibited>,
    /// The application's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A session change an [`Inhibition`] holds off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Inhibited {
    Logout,
    UserSwitch,
    Suspend,
}

/// Input devices a session asks for or was granted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Devices {
    pub keyboard: bool,
    pub pointer: bool,
    pub touchscreen: bool,
}

/// What a RemoteDesktop session asks to control.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteDesktopDialog {
    pub devices: Devices,
    /// Whether it asked to share the clipboard.
    pub clipboard: bool,
}

/// What an InputCapture session asks to take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputCaptureDialog {
    pub devices: Devices,
}

/// A running session that controls or captures input, as `kind` and `body`
/// on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capturing {
    /// The id [`PortalAnswer::Stop`] answers. Never shared with a request.
    pub id: u32,
    /// The application's desktop file id, as the portal frontend names it.
    pub app_id: String,
    #[serde(flatten)]
    pub kind: CapturingKind,
}

/// What a [`Capturing`] session holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "body", rename_all = "snake_case")]
pub enum CapturingKind {
    /// Emulated input, and the clipboard when `clipboard` is set.
    RemoteDesktop { devices: Devices, clipboard: bool },
    /// The user's own input, once it crosses a barrier.
    InputCapture { devices: Devices },
    /// What a screen cast records.
    ScreenCast { sources: Vec<Captured> },
    /// A screen recording the shell started, into `file`. The shell pauses,
    /// resumes, stops and discards it with [`PortalAnswer::Pause`],
    /// [`PortalAnswer::Resume`], [`PortalAnswer::Stop`] and
    /// [`PortalAnswer::Discard`].
    Recording {
        sources: Vec<Captured>,
        /// The absolute path of the WebM it records into.
        file: String,
        /// How long it recorded until `running_since_ms`, or until it paused.
        recorded_ms: u64,
        /// When it last started or resumed, in milliseconds since the Unix
        /// epoch. `None` while it is paused.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        running_since_ms: Option<u64>,
    },
    /// An agent the user let in, until it disconnects or the shell stops it.
    Agent(AgentSession),
}

/// An agent's ask to see and use the desk, as [`PortalKind::Agent`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDialog {
    /// What the agent calls itself, such as "Claude Code". Its own word, not
    /// checked.
    pub agent: String,
    /// The windows the user may pick from: every one open but private
    /// browser windows, which no agent reaches.
    pub windows: Vec<AgentWindow>,
    /// What it reaches now, when the user asked to change it with
    /// [`PortalAnswer::Change`]. Canceling keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<AgentReach>,
    /// Whether it is let in without asking now, so a change starts with
    /// Remember on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remembered: bool,
}

/// The agents the desk knows: those let in now, and those let in for good.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownAgents {
    /// Let in now, oldest first.
    pub connected: Vec<ConnectedAgent>,
    /// Let in without asking, by name, most recently used first.
    pub remembered: Vec<RememberedAgent>,
}

/// An agent let in now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectedAgent {
    /// Its [`CapturingKind::Agent`] session's id, which
    /// [`SystemRequest::StopAgent`] takes.
    pub session: u32,
    pub agent: String,
    pub reach: AgentReach,
}

/// An agent the user let reach the whole desk without asking again, until
/// [`SystemRequest::ForgetAgent`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RememberedAgent {
    pub agent: String,
    /// When it was last let in, in milliseconds since the Unix epoch.
    pub last_used_ms: u64,
}

/// A window an agent may be let reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentWindow {
    /// Its `list-windows` id: its `ext-foreign-toplevel-list-v1` identifier.
    pub id: String,
    pub kind: WindowKind,
    /// Empty when it has none.
    pub title: String,
    /// A native window's desktop entry id, or a browser window's app id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
}

/// What an agent may reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentReach {
    /// Every window, the pointer and the keyboard.
    Desk,
    /// These windows alone, through their accessibility trees and their own
    /// screenshots. Never the pointer or the keyboard.
    Windows { windows: Vec<AgentWindow> },
}

/// A running [`CapturingKind::Agent`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSession {
    pub agent: String,
    pub reach: AgentReach,
    /// What it did last, newest first, at most [`AGENT_ACTIONS`].
    pub actions: Vec<AgentAction>,
}

/// How many of an agent's actions its session lists.
pub const AGENT_ACTIONS: usize = 5;

/// One thing an agent did, as it says it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAction {
    /// Such as `Clicked "Save" in Notes`.
    pub said: String,
    /// When, in milliseconds since the Unix epoch.
    pub at_ms: u64,
}

/// An `AccessDialog`'s texts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessDialog {
    pub title: String,
    pub subtitle: String,
    /// May be empty.
    pub body: String,
    /// The allow button's label; the shell's own when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_label: Option<String>,
    /// The deny button's label; the shell's own when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_label: Option<String>,
    /// Whether allowing does something that cannot be undone, such as
    /// shutting down. Domicile's own option, not the spec's.
    pub destructive: bool,
}

/// An `AppChooser` request: what to open, and the applications offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppChooserDialog {
    /// Desktop file ids without `.desktop`, as the portal frontend names
    /// them. `UpdateChoices` replaces them while the dialog is up.
    pub choices: Vec<String>,
    /// The application chosen last time for this content type, to preselect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_choice: Option<String>,
    /// The MIME type being opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// The file's name, without its directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// A file chooser, in the shell's terms: the compositor has turned the
/// portal's globs, MIME types and byte-string paths into these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChooserDialog {
    pub mode: FileChooserMode,
    pub title: String,
    /// The confirm button's label; the shell's own when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_label: Option<String>,
    /// Open several files.
    pub multiple: bool,
    /// Open a folder rather than a file.
    pub directory: bool,
    /// The groups the user switches between; empty accepts any file.
    pub filters: Vec<FileFilter>,
    /// The index in `filters` to start with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_filter: Option<u32>,
    /// The absolute folder to start in; `home` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_folder: Option<String>,
    /// The user's absolute home directory, where the picker's places are.
    pub home: String,
    /// The suggested name for [`FileChooserMode::Save`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_name: Option<String>,
    /// The names [`FileChooserMode::SaveFiles`] saves into the chosen folder.
    pub files: Vec<String>,
    /// Extra questions, such as an encoding.
    pub choices: Vec<FileChoice>,
}

/// Which `FileChooser` method asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChooserMode {
    /// `OpenFile`: existing files or a folder.
    Open,
    /// `SaveFile`: one new path.
    Save,
    /// `SaveFiles`: a folder to save [`FileChooserDialog::files`] into.
    SaveFiles,
}

/// A named group of accepted extensions, such as "Images".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFilter {
    pub name: String,
    /// Lowercase and without the dot; empty accepts any file.
    pub extensions: Vec<String>,
}

/// A question asked beside the files. No options means a checkbox, answered
/// `"true"` or `"false"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChoice {
    pub id: String,
    pub label: String,
    pub options: Vec<FileChoiceOption>,
    /// The option id, or `"true"`/`"false"`, selected at first.
    pub initial: String,
}

/// One answer a [`FileChoice`] offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChoiceOption {
    pub id: String,
    pub label: String,
}

/// What the user chose in a [`PortalKind::FileChooser`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChooserAnswer {
    /// Absolute paths: the files, or the folder for
    /// [`FileChooserMode::SaveFiles`].
    pub paths: Vec<String>,
    /// Each [`FileChoice::id`]'s answer.
    pub choices: BTreeMap<String, String>,
    /// The index in [`FileChooserDialog::filters`] in use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_filter: Option<u32>,
}

/// A `GetUserInformation` call's texts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountDialog {
    /// Why the application asks, in its own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The name it would get.
    pub name: String,
    /// The path of the picture it would get.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

/// The shortcuts an application asks to bind, for the user to accept, change
/// or clear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutsDialog {
    pub shortcuts: Vec<ProposedShortcut>,
    /// Chords other applications hold, to flag as conflicts.
    pub taken: Vec<TakenChord>,
}

/// One shortcut a [`ShortcutsDialog`] reviews.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedShortcut {
    /// The application's id for it.
    pub id: String,
    pub description: String,
    /// The chord the user chose before, else the one the application
    /// prefers, as the application wrote it. Absent for neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

/// A chord another application holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TakenChord {
    pub chord: String,
    pub app_id: String,
}

/// A frame of the whole desk, frozen while the user picks from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrozenDesk {
    /// The frame, as a `data:` URL of a PNG.
    pub frame: String,
    /// The frame's size in pixels. Every rectangle here and in the answer is
    /// in these pixels.
    pub width: u32,
    pub height: u32,
    pub monitors: Vec<ShotArea>,
    pub windows: Vec<ShotWindow>,
    /// Where the frame is on the desktop, in logical pixels, which are the
    /// shell page's CSS pixels. The shell places its own windows with it.
    pub desk: DeskRect,
}

impl FrozenDesk {
    /// Whether `area` is a non-empty rectangle inside the frame.
    fn holds(&self, area: &ShotRect) -> bool {
        area.width > 0
            && area.height > 0
            && area
                .x
                .checked_add(area.width)
                .is_some_and(|right| right <= self.width)
            && area
                .y
                .checked_add(area.height)
                .is_some_and(|bottom| bottom <= self.height)
    }
}

/// A monitor of a [`FrozenDesk`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotArea {
    /// Its `wl_output` name.
    pub name: String,
    /// Its make, model and serial, or empty.
    pub description: String,
    pub area: ShotRect,
}

/// An open window of a [`FrozenDesk`], whether or not it is on screen.
///
/// The shell knows where it draws each window, so it finds a shown one on
/// the frame itself. One it does not show is saved from its own last frame;
/// see [`PortalAnswer::ScreenshotWindow`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotWindow {
    /// Its host app id.
    pub id: String,
    /// Empty until the client names it.
    pub title: String,
    /// Its Wayland app id, which names its desktop entry; empty if unset.
    pub app_id: String,
}

/// What a [`HostMessage::DeskShot`]'s PNG shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskShot {
    /// The desktop the PNG covers: every monitor.
    pub place: DeskRect,
    /// The PNG's size, in pixels.
    pub width: u32,
    pub height: u32,
}

/// One event of a [`ChromeMessage::Emulate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EmulatedInput {
    /// Move the pointer to `x`, `y`: logical pixels from the top-left corner
    /// of the desk, which is a [`DeskShot`]'s `place`.
    PointTo { x: f64, y: f64 },
    Button {
        button: PointerButton,
        pressed: bool,
    },
    /// Smooth scrolling, in logical pixels; positive is down and right.
    Scroll { dx: f64, dy: f64 },
    /// Press or release the key that types the XKB keysym named `key`, such
    /// as `Return` or `Control_L`.
    Key { key: String, pressed: bool },
    /// Type `text`, a key for each character; a line break presses Return.
    Text { text: String },
    /// Wait `ms` milliseconds before the next event, as a hand would between
    /// the moves of a drag.
    Wait { ms: u32 },
}

/// A pointer button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

/// A rectangle of the desktop, in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskRect {
    pub position: (i32, i32),
    pub size: (i32, i32),
}

/// A rectangle of a [`FrozenDesk`]'s frame, in its pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The chord the user chose for one shortcut of a [`ShortcutsDialog`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChosenTrigger {
    pub id: String,
    /// Absent when the user cleared it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

/// A chord an application holds, as [`HostMessage::PortalRequests`] lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundShortcut {
    /// The id [`PortalAnswer::Pressed`] and [`PortalAnswer::Released`] are
    /// sent under. Not a request's id.
    pub id: u32,
    pub app_id: String,
    /// In the shell's chord syntax; see `docs/architecture/KEYBINDINGS.md`.
    pub chord: String,
}

/// A screen cast source picker's choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenCastDialog {
    /// Whether the user may pick more than one source.
    pub multiple: bool,
    /// What may be shared, of the types the application asked for.
    pub sources: Vec<CastSource>,
    /// Whether the user may draw a region of the desktop instead.
    pub region: bool,
    /// Whether the user may pick a browser window's page alone. The
    /// compositor does not list them: the shell offers the engine's own list,
    /// and answers [`CastPick::BrowserWindow`].
    pub browser_windows: bool,
    /// A frame of the desk to preview the sources on, as the Screenshot
    /// dialog's. `None` when the desk could not be shot, such as before the
    /// engine connects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desk: Option<FrozenDesk>,
}

/// One source a [`ScreenCastDialog`] offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CastSource {
    /// A window.
    Window {
        /// Its host app id.
        id: String,
        /// Empty until the client names it.
        title: String,
        /// Its Wayland app id, which names its desktop entry; empty if unset.
        app_id: String,
    },
    /// A monitor.
    Monitor {
        /// Its `wl_output` name.
        name: String,
        /// Its make, model and serial, or empty.
        description: String,
        /// In logical pixels.
        size: (i32, i32),
    },
}

/// A source the user picked in a [`ScreenCastDialog`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CastPick {
    /// The window with this host app id.
    Window {
        id: String,
        /// Part of it alone, in pixels of its frame as
        /// [`PreviewedWindow`] draws it. All of it when `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<ShotRect>,
    },
    /// A browser window's page alone, by the engine's window id, with the
    /// title the shell names it by.
    BrowserWindow {
        id: String,
        title: String,
        /// Part of it alone, in pixels of its frame as
        /// [`PreviewedWindow`] draws it. All of it when `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<ShotRect>,
    },
    /// The monitor with this `wl_output` name.
    Monitor { name: String },
    /// A rectangle of the desktop, in logical pixels.
    Region {
        position: (i32, i32),
        size: (i32, i32),
    },
}

/// One source a [`CapturingKind::ScreenCast`] records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Captured {
    /// A window, by host app id, with its title and its application's
    /// Wayland app id when the capture started. The app id is empty when
    /// the window has none.
    Window {
        id: String,
        title: String,
        app_id: String,
    },
    /// A browser window's page, by the engine's window id, with its title
    /// when it was picked.
    BrowserWindow { id: String, title: String },
    /// A monitor, or a region that covers one exactly.
    Monitor(CapturedMonitor),
    /// A region that covers every monitor of a desktop with several.
    Desk,
    /// A rectangle of the desktop, in logical pixels, with the monitor it is
    /// mostly on. `None` when it is on none.
    Region {
        position: (i32, i32),
        size: (i32, i32),
        #[serde(default, skip_serializing_if = "Option::is_none")]
        monitor: Option<CapturedMonitor>,
    },
}

/// A monitor a screen cast records, as the shell names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapturedMonitor {
    /// Its `wl_output` name.
    pub name: String,
    /// Its make and model, or empty when it reports none.
    pub description: String,
}

/// A print dialog: the printers CUPS offers, each with what it supports, and
/// saving to a PDF.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrintDialog {
    /// The document's title.
    pub title: String,
    /// The print button's label; the shell's own when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_label: Option<String>,
    /// Empty when CUPS has none or cannot be reached.
    pub printers: Vec<Printer>,
    /// The printer to start with: the application's last, else CUPS's
    /// default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub printer: Option<String>,
    /// The user's home directory, where the PDF's file picker starts.
    pub home: String,
    /// What saving to a PDF offers, as a printer would. Its `name` is not a
    /// CUPS queue.
    pub pdf: Printer,
}

/// A CUPS queue and the options it supports. An empty list means the
/// printer takes no choice of that option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Printer {
    /// The CUPS queue name.
    pub name: String,
    /// CUPS's `printer-info`, for people.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub media: Vec<Media>,
    pub sides: Vec<Sides>,
    pub color_modes: Vec<ColorMode>,
    pub orientations: Vec<Orientation>,
    pub qualities: Vec<PrintQuality>,
    /// The most copies one job may ask for.
    pub copies_max: u32,
    /// Whether it prints only some pages.
    pub page_ranges: bool,
    /// What the dialog starts with for this printer: the application's
    /// settings where the printer supports them, else its defaults.
    pub initial: PrintOptions,
}

/// A paper size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Media {
    /// The PWG self-describing name, such as `iso_a4_210x297mm`.
    pub name: String,
    /// For people, such as `A4 (210 × 297 mm)`.
    pub label: String,
}

/// IPP's `sides`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sides {
    OneSided,
    /// Bound along the long edge, as a book.
    TwoSidedLongEdge,
    /// Bound along the short edge, as a notepad.
    TwoSidedShortEdge,
}

/// IPP's `print-color-mode`, as far as a dialog offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorMode {
    Color,
    Monochrome,
}

/// IPP's `orientation-requested`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    Portrait,
    Landscape,
    ReverseLandscape,
    ReversePortrait,
}

/// IPP's `print-quality`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrintQuality {
    Draft,
    Normal,
    High,
}

/// Pages `first` to `last`, counted from 1, both included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageRange {
    pub first: u32,
    pub last: u32,
}

/// A print job's options. An absent option is the printer's default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrintOptions {
    /// A [`Media::name`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    pub copies: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sides: Option<Sides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_mode: Option<ColorMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<Orientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<PrintQuality>,
    /// Empty prints every page.
    pub pages: Vec<PageRange>,
}

/// The shell's answer to a [`PortalRequest`].
///
/// Each backend reads only its own kind; any other answer refuses the
/// request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PortalAnswer {
    /// The user allowed a [`PortalKind::Access`] or a [`PortalKind::Account`].
    Access,
    /// The application the user picked in a [`PortalKind::AppChooser`]: one
    /// of its `choices`.
    AppChooser { choice: String },
    /// The user chose in a [`PortalKind::FileChooser`].
    FileChooser(FileChooserAnswer),
    /// The user granted a [`PortalKind::RemoteDesktop`] these devices, and the
    /// clipboard when `clipboard` is set. The compositor grants no more than
    /// was asked.
    RemoteDesktop { devices: Devices, clipboard: bool },
    /// The user allowed a [`PortalKind::InputCapture`].
    InputCapture,
    /// The user installs a [`PortalKind::DynamicLauncher`] under `name`.
    DynamicLauncher { name: String },
    /// The user picked these sources in a [`PortalKind::ScreenCast`].
    ScreenCast { sources: Vec<CastPick> },
    /// The printer the user picked in a [`PortalKind::Print`], one of its
    /// `printers`, and the options.
    Print {
        printer: String,
        options: PrintOptions,
    },
    /// The user saves a [`PortalKind::Print`]'s document as a PDF at the
    /// absolute `path`, with the options of its `pdf`.
    SaveToPdf { path: String, options: PrintOptions },
    /// The user stopped a [`Capturing`] session.
    Stop,
    /// The chords the user chose in a [`PortalKind::GlobalShortcuts`].
    GlobalShortcuts { triggers: Vec<ChosenTrigger> },
    /// The area of a [`PortalKind::Screenshot`] the user kept.
    ///
    /// `copy` also puts it on the clipboard as a PNG (Ctrl+C in the dialog).
    /// The shell's own screenshot is then not saved.
    Screenshot {
        area: ShotRect,
        #[serde(default)]
        copy: bool,
    },
    /// The [`ShotWindow`] of a [`PortalKind::Screenshot`] the user picked,
    /// saved from its own last frame rather than from the frozen desk.
    /// `copy` as for [`PortalAnswer::Screenshot`].
    ScreenshotWindow {
        id: String,
        #[serde(default)]
        copy: bool,
        /// Part of it alone, in pixels of its frame as
        /// [`PreviewedWindow`] draws it. All of it when `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<ShotRect>,
    },
    /// A browser window of a [`PortalKind::Screenshot`] the user picked, by
    /// the id the engine's browser window list gives it. Saved from the
    /// engine's capture of its page alone, so nothing over it is in the shot.
    /// `copy` as for [`PortalAnswer::Screenshot`].
    ScreenshotBrowserWindow {
        id: String,
        #[serde(default)]
        copy: bool,
        /// Part of it alone, in pixels of its frame as
        /// [`PreviewedWindow`] draws it. All of it when `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<ShotRect>,
    },
    /// The pixel of a [`PortalKind::PickColor`] the user picked.
    PickColor { x: u32, y: u32 },
    /// What the user lets a [`PortalKind::Agent`] reach. Windows must be
    /// ones its dialog offered; the compositor drops any other. `remember`
    /// lets the agent reach the whole desk later without asking; it takes
    /// [`AgentReach::Desk`].
    Agent {
        reach: AgentReach,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        remember: bool,
    },
    /// Ask the user again what the [`CapturingKind::Agent`] with this id may
    /// reach. Answers no request.
    Change,
    /// Pause the [`CapturingKind::Recording`] with this id. Answers no
    /// request.
    Pause,
    /// Resume the paused [`CapturingKind::Recording`] with this id. Answers
    /// no request.
    Resume,
    /// Stop the [`CapturingKind::Recording`] with this id and delete its
    /// file. Answers no request.
    Discard,
    /// The [`BoundShortcut`] with this id fired. Answers no request.
    Pressed,
    /// The [`BoundShortcut`] with this id was let go. Answers no request.
    Released,
    /// The user dismissed the dialog, or denied it.
    Canceled,
    /// The shell has no dialog for this kind.
    Refused,
}

impl PortalAnswer {
    /// The portal's `response`: 0 for success, 1 for canceled by the user,
    /// 2 for any other end.
    pub fn response(&self) -> u32 {
        match self {
            PortalAnswer::Access
            | PortalAnswer::DynamicLauncher { .. }
            | PortalAnswer::AppChooser { .. }
            | PortalAnswer::FileChooser(_)
            | PortalAnswer::RemoteDesktop { .. }
            | PortalAnswer::InputCapture
            | PortalAnswer::GlobalShortcuts { .. }
            | PortalAnswer::ScreenCast { .. }
            | PortalAnswer::Print { .. }
            | PortalAnswer::SaveToPdf { .. }
            | PortalAnswer::Screenshot { .. }
            | PortalAnswer::ScreenshotWindow { .. }
            | PortalAnswer::ScreenshotBrowserWindow { .. }
            | PortalAnswer::PickColor { .. }
            | PortalAnswer::Agent { .. }
            | PortalAnswer::Stop => 0,
            PortalAnswer::Canceled => 1,
            PortalAnswer::Refused
            | PortalAnswer::Change
            | PortalAnswer::Pause
            | PortalAnswer::Resume
            | PortalAnswer::Discard
            | PortalAnswer::Pressed
            | PortalAnswer::Released => 2,
        }
    }
}

/// A window a [`SystemRequest::PreviewWindow`] draws.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PreviewedWindow {
    /// A client's window, by host app id.
    App { id: String },
    /// A browser window's page, by the engine's window id.
    Browser { id: String },
}

/// A monitor's device pixels per logical pixel, such as 1.5. Always finite
/// and above zero: a message with any other scale does not parse.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct Scale(f64);

impl Scale {
    /// One device pixel a logical pixel.
    pub const ONE: Scale = Scale(1.0);

    pub fn get(self) -> f64 {
        self.0
    }
}

impl Default for Scale {
    fn default() -> Self {
        Scale::ONE
    }
}

// Sound: a `Scale` is never NaN.
impl Eq for Scale {}

impl TryFrom<f64> for Scale {
    type Error = String;

    fn try_from(scale: f64) -> Result<Self, Self::Error> {
        if scale.is_finite() && scale > 0.0 {
            Ok(Scale(scale))
        } else {
            Err(format!(
                "a scale must be finite and above zero, not {scale}"
            ))
        }
    }
}

impl From<Scale> for f64 {
    fn from(scale: Scale) -> f64 {
        scale.0
    }
}

/// What a [`ChromeMessage::SystemRequest`] asks for.
///
/// A relative path is read from the home directory. Bytes travel as standard
/// padded base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "snake_case")]
pub enum SystemRequest {
    /// Read a file from byte `offset`, at most `length` bytes, or to its end
    /// without one. Answered with [`SystemReply::Read`], short at the end of
    /// the file.
    ReadFile {
        path: String,
        #[serde(default)]
        offset: u64,
        #[serde(default)]
        length: Option<u64>,
    },
    /// Write a whole file, creating it if needed. Answered with
    /// [`SystemReply::Written`].
    ///
    /// `atomic` writes a temporary file beside it and renames it over, so a
    /// reader never sees half a file. Files under `/sys` and `/proc` cannot be
    /// renamed over, so write those with `atomic` off.
    WriteFile {
        path: String,
        data: String,
        atomic: bool,
    },
    /// Create a directory, failing if anything has its name. Answered with
    /// [`SystemReply::Created`].
    CreateDir { path: String },
    /// List a directory. Answered with [`SystemReply::Entries`].
    ReadDir { path: String },
    /// Describe a path, following symlinks. Answered with
    /// [`SystemReply::Stat`].
    Stat { path: String },
    /// Report changes to a file or to a directory's entries. Answered with
    /// [`SystemReply::Started`], then a [`SystemEvent::Changed`] per change.
    Watch { path: String },
    /// End the watch or D-Bus match with this id. It ends with
    /// [`SystemEnd::Stopped`].
    Unwatch,
    /// Run a program. Answered with [`SystemReply::Started`], then its output
    /// as [`SystemEvent::Output`], then [`SystemEnd::Exited`].
    ///
    /// `argv[0]` is looked up on the compositor's `PATH`; there is no shell.
    /// `cwd` defaults to the home and `env` adds to the compositor's
    /// environment. Without `stdin` the program reads `/dev/null`.
    Spawn {
        argv: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        stdin: bool,
    },
    /// Write to the standard input of the process with this id.
    Stdin { data: String },
    /// Close the standard input of the process with this id.
    CloseStdin,
    /// Signal the process with this id.
    Kill { signal: Signal },
    /// Call a D-Bus method. Answered with [`SystemReply::Returned`], or
    /// [`SystemErrorKind::Dbus`] when the method returns an error.
    ///
    /// `body` is JSON text: an array with one element per type in
    /// `signature`. See `domicile_host::dbus_json` for how each D-Bus type is
    /// written.
    DbusCall {
        bus: Bus,
        destination: String,
        path: String,
        interface: String,
        member: String,
        signature: String,
        body: String,
    },
    /// Report the signals matching every field given. Answered with
    /// [`SystemReply::Started`], then a [`SystemEvent::Signal`] per signal.
    /// [`SystemRequest::Unwatch`] ends it.
    DbusMatch {
        bus: Bus,
        #[serde(default)]
        sender: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        interface: Option<String>,
        #[serde(default)]
        member: Option<String>,
    },
    /// Take a screenshot: one frame of every monitor, as the Screenshot portal
    /// takes. Answered with [`SystemReply::Saved`], or [`SystemReply::Copied`]
    /// when the user copied it from the dialog.
    ///
    /// Without `file`, the shell's screenshot dialog picks the area, as for
    /// an interactive portal screenshot asked by [`SHELL_APP_ID`], and the PNG
    /// goes under `$XDG_PICTURES_DIR/Screenshots/`. A dismissed dialog fails
    /// with [`SystemErrorKind::Canceled`]. With `file`, the whole desk is
    /// written there, without a dialog.
    Screenshot {
        #[serde(default)]
        file: Option<String>,
    },
    /// Record what the user picks in the shell's [`PortalKind::ScreenCast`]
    /// picker, asked by [`SHELL_APP_ID`], to a WebM in the videos directory.
    /// Listed as a [`CapturingKind::Recording`] while it runs. Answered with
    /// [`SystemReply::Saved`] once the user stops it, or
    /// [`SystemErrorKind::Canceled`] when the picker is dismissed or the
    /// recording discarded. `domicile screen-record` sends this.
    ScreenRecord,
    /// Draw `window` as it last drew itself, for a picker to preview one it
    /// cannot see on the frozen desk. Answered with [`SystemReply::Preview`].
    PreviewWindow { window: PreviewedWindow },
    /// Report each command sent with [`SystemRequest::SendShell`]. Answered
    /// with [`SystemReply::Started`], then a [`SystemEvent::ShellCommand`] per
    /// command, which the page answers with
    /// [`SystemRequest::AnswerShellCommand`]. [`SystemRequest::Unwatch`] ends
    /// it.
    ///
    /// `commands` describes what the page runs, for
    /// `domicile list-shell-commands`, and `bindings` the keys and gestures
    /// that run them, for `domicile list-bindings`, while it listens.
    ShellCommands {
        #[serde(default)]
        commands: Vec<ShellCommandHelp>,
        #[serde(default)]
        bindings: Vec<ShellBinding>,
    },
    /// Send `command` to every page listening with
    /// [`SystemRequest::ShellCommands`], as a `send-shell` keybinding would
    /// run it. Answered with [`SystemReply::Sent`] once a page ran it, or a
    /// failure when every page refused it or none answered in time.
    /// `domicile send-shell` sends this.
    SendShell { command: Vec<String> },
    /// Open links of `schemes` for the desktop: report each one
    /// [`SystemRequest::OpenLink`] hands over. `domicile open`, and so
    /// `xdg-open` and applications' links, and the Email portal hand them
    /// over. Answered with [`SystemReply::Started`], then a
    /// [`SystemEvent::Link`] per link. [`SystemRequest::Unwatch`] ends it.
    ///
    /// `schemes` are without the colon, such as `mailto`, in any case. A
    /// link goes to the page that claimed its scheme last.
    ClaimLinks { schemes: Vec<String> },
    /// Hand `url` to the page that claimed its scheme with
    /// [`SystemRequest::ClaimLinks`]. `app_id` is the desktop file id of the
    /// application that asked, when known. Answered with
    /// [`SystemReply::Sent`] once the page has it, or
    /// [`SystemErrorKind::NotFound`] when no page claims its scheme.
    OpenLink {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
    },
    /// Say whether this page ran the [`SystemEvent::ShellCommand`] numbered
    /// `sent`: `refused` says why not. A command that ran may answer with
    /// `output`, such as a query's JSON, which `domicile send-shell` prints.
    /// Answered with [`SystemReply::Set`].
    AnswerShellCommand {
        sent: u64,
        #[serde(default)]
        refused: Option<String>,
        #[serde(default)]
        output: Option<String>,
    },
    /// Report when nobody has been at the desktop for `seconds`, and when
    /// somebody is again. Answered with [`SystemReply::Started`], then a
    /// [`SystemEvent::Idle`] on each change: `true` that long after the last
    /// input, `false` on the next. Idle inhibitors hold it off as they hold
    /// off blanking. [`SystemRequest::Unwatch`] ends it.
    ///
    /// `seconds` must be at least 1. See `docs/IDLE.md`.
    IdleAfter { seconds: u64 },
    /// As [`SystemRequest::IdleAfter`], `seconds` before the screens blank,
    /// so a shell can dim or count down. Silent on a desktop whose screens
    /// never blank, or blank sooner than `seconds`.
    IdleBeforeBlanking { seconds: u64 },
    /// Report each passphrase the lock did not take. Answered with
    /// [`SystemReply::Started`], then a [`SystemEvent::UnlockRefused`] per
    /// refusal, to every page listening. [`SystemRequest::Unwatch`] ends it.
    UnlockRefusals,
    /// Replace the `xdg_toplevel` states the shell sets on window `app_id`
    /// with `states`, and configure it. Answered with [`SystemReply::Set`],
    /// or [`SystemErrorKind::NotFound`] for a window the compositor does not
    /// know. See `docs/WRITING-A-SHELL.md`.
    SetWindowStates {
        app_id: String,
        states: Vec<WindowState>,
    },
    /// Report each maximize and fullscreen request a client makes. Answered
    /// with [`SystemReply::Started`], then a [`SystemEvent::WindowRequest`]
    /// per request. [`SystemRequest::Unwatch`] ends it.
    WindowRequests,
    /// Report each time a client rings `xdg_system_bell_v1`. Answered with
    /// [`SystemReply::Started`], then a [`SystemEvent::Bell`] per ring.
    /// [`SystemRequest::Unwatch`] ends it.
    Bells,
    /// Add a monitor with no connector, `width`×`height` pixels at
    /// `refresh_mhz`, which the desk extends onto and only a capture shows:
    /// casting to a TV. `name` becomes its description. Answered with
    /// [`SystemReply::VirtualMonitor`]; a later [`HostMessage::Displays`]
    /// lists it. [`SystemRequest::Unwatch`] removes it, as does the page going
    /// away.
    ///
    /// Only on a tty. Nested, Domicile's window is the desktop, and this
    /// fails with [`SystemErrorKind::Other`]. See
    /// `docs/CASTING-TO-TVS.md`.
    VirtualMonitor {
        name: String,
        width: u32,
        height: u32,
        refresh_mhz: u32,
        /// Device pixels per logical pixel; 1 when left out.
        #[serde(default)]
        scale: Scale,
    },
    /// Resize the virtual monitor this id added to `width`×`height` pixels
    /// at `refresh_mhz` and `scale`. It keeps its `wl_output`, its windows
    /// and any capture of it. No reply; a later [`HostMessage::Displays`]
    /// shows it. Allowed while the desktop is locked.
    ResizeVirtualMonitor {
        width: u32,
        height: u32,
        refresh_mhz: u32,
        /// Device pixels per logical pixel; 1 when left out.
        #[serde(default)]
        scale: Scale,
    },
    /// Let the agent `agent` see and use the desk, as the user allows in a
    /// [`PortalKind::Agent`] dialog. Answered with [`SystemReply::Agent`]
    /// once allowed, or [`SystemErrorKind::Canceled`] when the user cancels
    /// or does not answer within a minute. Listed as a
    /// [`CapturingKind::Agent`] until [`SystemRequest::Unwatch`] or the
    /// caller going away. When the shell stops it, ends with
    /// [`SystemEnd::Stopped`]. `domicile agent` sends this.
    Agent { agent: String },
    /// Note that the agent this id let in did `said`, for the shell to list.
    /// No reply.
    AgentDid { said: String },
    /// Report the agents let in now and those remembered. Answered with
    /// [`SystemReply::Agents`].
    Agents,
    /// End the [`CapturingKind::Agent`] session `session`, as the shell's
    /// [`PortalAnswer::Stop`] does. Answered with [`SystemReply::Set`].
    StopAgent { session: u32 },
    /// Make the remembered agent `agent` ask again next time. Answered with
    /// [`SystemReply::Set`], whether or not it was remembered.
    ForgetAgent { agent: String },
    /// Report the keymaps the desktop switches between and which it types
    /// on. Answered with [`SystemReply::Started`], then a
    /// [`SystemEvent::Keymaps`] at once and on each change.
    /// [`SystemRequest::Unwatch`] ends it.
    Keymaps,
    /// Report what holds the desktop awake: the idle inhibitors that keep the
    /// screens from blanking and the desktop from locking. Answered with
    /// [`SystemReply::Started`], then a [`SystemEvent::IdleHolds`] at once and
    /// on each change. [`SystemRequest::Unwatch`] ends it. See `docs/IDLE.md`.
    IdleHolds,
    /// Switch every keyboard to `keymap`, one of `input.keyboard`'s keymaps.
    /// Answered with [`SystemReply::Set`], or [`SystemErrorKind::NotFound`]
    /// for a name the config does not have. Lasts until the desktop restarts.
    SelectKeymap { keymap: KeymapChoice },
    /// Activate, deactivate or toggle the shortcuts inhibitor of the window
    /// with the keyboard, as sway's `seat shortcuts_inhibitor` does: the way
    /// back to the desktop from a VM. Answered with [`SystemReply::Set`]. A
    /// window holding none changes nothing; a new inhibitor starts active.
    /// [`HostMessage::AppInhibitsShortcuts`] follows each change. See
    /// `docs/architecture/KEYBINDINGS.md`.
    ShortcutsInhibitor { action: InhibitorAction },
    /// Draw `display`, any name a profile matches it by, or every monitor
    /// when `None`, as if its white were a light of `kelvin`, as a night light
    /// does; `6500` draws colors as they are. Every monitor's replaces each
    /// one's. Answered with [`SystemReply::Set`],
    /// [`SystemErrorKind::InvalidInput`] outside 1000 to 6500, or
    /// [`SystemErrorKind::NotFound`] for a display the desktop does not have.
    /// Changes nothing on a nested desktop, nor on a monitor a gamma-control
    /// client holds. See `docs/DISPLAYS.md#night-light-and-gamma-control`.
    SetColorTemperature {
        kelvin: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<String>,
    },
    /// Turn every monitor off now, keeping the desktop as it is. Input more
    /// than a second later, or [`SystemRequest::WakeDisplays`], lights them
    /// again. With `display`, any name a profile matches it by, turn only
    /// that one off; it keeps its place and windows, and sleeps through input until
    /// woken. Answered with [`SystemReply::Set`], or
    /// [`SystemErrorKind::NotFound`] for a display the desktop does not have.
    /// See `docs/IDLE.md#sleeping-on-demand`.
    SleepDisplays {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<String>,
    },
    /// Light the monitors again, as input would: after
    /// [`SystemRequest::SleepDisplays`] or idle blanking. With `display`,
    /// light only that one. Answered as `SleepDisplays` is.
    WakeDisplays {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<String>,
    },
}

/// What [`SystemRequest::ShortcutsInhibitor`] does to the inhibitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InhibitorAction {
    Activate,
    Deactivate,
    Toggle,
}

/// Which keymap [`SystemRequest::SelectKeymap`] switches to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeymapChoice {
    /// The one after the active keymap, or the first after the last.
    Next,
    /// The keymap with this name.
    Named { name: String },
}

/// One of the keymaps [`SystemEvent::Keymaps`] lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedKeymap {
    /// The config's name for it.
    pub name: String,
    /// xkb's name for its layouts, such as `English (programmer Dvorak)`,
    /// or `None` when xkb names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// An `xdg_toplevel` state the shell sets with
/// [`SystemRequest::SetWindowStates`]. A client bound below `xdg_wm_base`
/// version 2 is sent `maximized` in place of tiled states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    TiledLeft,
    TiledRight,
    TiledTop,
    TiledBottom,
    Maximized,
    Fullscreen,
    /// The window is being resized, so the client may skip work such as
    /// reflowing until the resize ends.
    Resizing,
}

/// What a client asked of its window. The compositor only reports it; the
/// shell grants it with [`SystemRequest::SetWindowStates`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowRequest {
    Maximize,
    Unmaximize,
    /// `display` is the [`DisplayInfo::name`] the client named, if any.
    Fullscreen {
        display: Option<String>,
    },
    Unfullscreen,
    /// `xdg_toplevel.set_minimized`. A minimized window is the shell's own
    /// idea; xdg-shell has no state for it.
    Minimize,
    /// `xdg_toplevel.move`: the client's title bar was pressed and dragged.
    /// The button is still down, and the client has been told the pointer
    /// left, so the drag is the shell's to run until the button comes up.
    Move,
    /// `xdg_toplevel.resize`: the client's resize border was pressed and
    /// dragged, from `edges`. The press is the shell's, as for
    /// [`WindowRequest::Move`].
    Resize {
        edges: ResizeEdges,
    },
}

/// The edges a client's resize drag pulls, as `xdg_toplevel.resize_edge`
/// names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeEdges {
    Top,
    Bottom,
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// The `app_id` of a portal dialog the shell asked for itself, such as
/// [`SystemRequest::Screenshot`]'s. Not a valid application id, since it
/// holds a colon, so no application can be named this.
pub const SHELL_APP_ID: &str = "domicile:shell";

/// Which D-Bus bus a call or match is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bus {
    Session,
    System,
}

/// A signal for [`SystemRequest::Kill`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Signal {
    Hup,
    Int,
    Term,
    Kill,
    Usr1,
    Usr2,
}

/// The answer to a [`SystemRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemReply {
    /// A file's contents, base64.
    Read { data: String },
    /// The file was written.
    Written,
    /// The directory was created.
    Created,
    /// A directory's entries, in no particular order.
    Entries { entries: Vec<DirEntry> },
    /// A path's type, size in bytes, modification time in milliseconds
    /// since the epoch, and absolute path with every link resolved. Files
    /// under `/sys` and `/proc` report a size of 4096 or 0 whatever they
    /// hold.
    Stat {
        file_type: FileType,
        size: u64,
        modified_ms: Option<u64>,
        real_path: Option<String>,
    },
    /// What a D-Bus method returned: JSON text for its body, as
    /// [`SystemRequest::DbusCall`] takes one, and the signature to read it by.
    Returned { signature: String, body: String },
    /// The watch, match or process is running.
    Started,
    /// The screenshot was written to this absolute path.
    Saved { path: String },
    /// The screenshot was put on the clipboard and not saved.
    Copied,
    /// A window's frame, as a `data:` URL of a PNG.
    Preview { frame: String },
    /// A page ran the command, and what it printed, if anything.
    Sent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    /// The window's states were replaced, or the color temperature set.
    Set,
    /// The virtual monitor was added, as the `wl_output` named `output`.
    VirtualMonitor { output: String },
    /// The user let the agent reach this. A
    /// [`SystemEvent::AgentReach`] follows each time they change it.
    Agent { reach: AgentReach },
    /// The agents the desk knows.
    Agents(KnownAgents),
    /// The call failed. Nothing else follows under this id.
    Failed { error: SystemError },
}

/// One entry of a directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    /// The entry's own type: a symlink is reported as one, not followed.
    pub file_type: FileType,
}

/// What a path is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileType {
    File,
    Directory,
    Symlink,
    /// A device, socket or pipe.
    Other,
}

/// Something a running watch or process produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemEvent {
    /// Bytes a process wrote, base64, in the order it wrote them on each
    /// stream.
    Output { stream: Stream, data: String },
    /// The watched file, or an entry of the watched directory, changed.
    /// `path` is absolute.
    Changed { path: String },
    /// A command sent with [`SystemRequest::SendShell`], numbered `sent` for
    /// [`SystemRequest::AnswerShellCommand`].
    ShellCommand { command: Vec<String>, sent: u64 },
    /// A link handed over with [`SystemRequest::OpenLink`], for the page to
    /// open. `app_id` is the asking application's desktop file id, when
    /// known.
    Link {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_id: Option<String>,
    },
    /// Whether nobody has been at the desktop for the time a
    /// [`SystemRequest::IdleAfter`] or [`SystemRequest::IdleBeforeBlanking`]
    /// named.
    Idle { idle: bool },
    /// A [`ChromeMessage::Unlock`] that left the desktop locked.
    ///
    /// `failures` counts refused passphrases, wrong or unverifiable, since the
    /// desktop last opened.
    /// `retry_in_ms` is how long the compositor refuses every passphrase,
    /// unchecked, with [`UnlockRefusal::TooSoon`].
    UnlockRefused {
        refusal: UnlockRefusal,
        failures: u32,
        retry_in_ms: u64,
    },
    /// The client of window `app_id` asked for `request`.
    WindowRequest {
        app_id: String,
        request: WindowRequest,
    },
    /// A client rang the bell, from window `app_id`, or from none when it
    /// named no surface or one that is not a window.
    Bell { app_id: Option<String> },
    /// The user changed what the agent this id let in may reach.
    AgentReach { reach: AgentReach },
    /// The keymaps the desktop switches between, in the config's order, and
    /// the name of the one it types on.
    Keymaps {
        keymaps: Vec<ListedKeymap>,
        active: String,
    },
    /// What holds the desktop awake, one app id per idle inhibitor: the
    /// window's app id for a Wayland inhibitor, the application for a portal
    /// one, for the shell to name. Empty when nothing does.
    IdleHolds { holders: Vec<String> },
    /// A D-Bus signal a match named, its body written as
    /// [`SystemReply::Returned`]'s is.
    Signal {
        sender: String,
        path: String,
        interface: String,
        member: String,
        signature: String,
        body: String,
    },
}

/// Why the lock did not take a passphrase. See `docs/LOCK.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnlockRefusal {
    /// The verifier checked it, and it is wrong.
    WrongPassphrase,
    /// The verifier could not check it, such as a PAM module missing.
    Unverifiable,
    /// Offered during the wait after repeated refused passphrases, so it was
    /// not checked.
    TooSoon,
}

/// One of a process's output streams.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// How a watch or process ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemEnd {
    /// The process exited with `code`, or was killed by `signal`. Sent after
    /// all its output.
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// The watch or match ended on [`SystemRequest::Unwatch`].
    Stopped,
    /// The watch or process broke.
    Failed { error: SystemError },
}

/// Why a system call failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemError {
    pub kind: SystemErrorKind,
    /// The operating system's description, for logs. Not for matching.
    pub message: String,
}

/// The kinds of [`SystemError`] a shell can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemErrorKind {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    NotADirectory,
    IsADirectory,
    /// The request itself was wrong: bad base64, an empty argv, or an id that
    /// is already running.
    InvalidInput,
    /// The desktop is locked. See `docs/LOCK.md`.
    Locked,
    /// A D-Bus method returned an error. The message starts with its name,
    /// such as `org.freedesktop.DBus.Error.ServiceUnknown`.
    Dbus,
    /// The user dismissed the dialog the call put up.
    Canceled,
    /// The compositor exited with the call open. Sent only by the browser,
    /// which ends the page's calls when its compositor hangs up; the SDK
    /// resubscribes a watch that ends this way. See "A compositor restart" in
    /// `docs/architecture/ENGINE-FORK.md`.
    CompositorGone,
    Other,
}

/// One clipboard history entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipboardEntry {
    /// The id [`ChromeMessage::CopyClipboardEntry`] and
    /// [`ChromeMessage::RemoveClipboardEntry`] use.
    ///
    /// Never reused, so a stale id matches nothing. Not a position. 32 bits
    /// because the browser process carries it in a `base::Value`, whose
    /// integers are signed 32-bit.
    pub id: u32,

    /// Whether the copy is an image with no text, so a shell can draw it as
    /// one. Its `preview` then names its size or format.
    pub image: bool,

    /// A possibly truncated preview of the copied text, or the size of a
    /// copied image with no text (`Image, 1920 × 1080`).
    ///
    /// Long entries are cut at
    /// `domicile_host::clipboard::PREVIEW_CHARACTERS`; restoring the entry
    /// always restores the whole copy.
    pub preview: String,

    /// A small picture of a copied image with no text, as a PNG `data:` URL,
    /// at most `domicile_host::thumbnail::LONGEST_SIDE` pixels a side.
    /// Absent for text, and for an image the compositor could not read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,

    /// Whether this is what the clipboard holds. Only the newest entry can
    /// be, and none is after the current entry is removed, until the next
    /// copy or restore.
    pub current: bool,
}

/// One display, in logical units (CSS pixels).
///
/// Positions share one desktop-wide space whose origin is the top-left of the
/// displays' bounding box, so they are never negative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayInfo {
    /// What the shell addresses this display by, e.g. `<Screen name="left">`.
    pub name: String,
    /// Its top-left corner in the desktop's coordinate space.
    pub position: [i32; 2],
    /// Its width and height, logical, after rotation.
    pub size: [u32; 2],
    /// The `wl_output` scale advertised to clients on this display.
    ///
    /// Not the chrome's own render scale: the chrome is one page with one
    /// `devicePixelRatio`.
    pub scale: u32,
    /// The monitor's mode in physical pixels, before rotation.
    ///
    /// Informational only; the engine rotates and scales each monitor's slice
    /// itself. A portrait 4K panel is `mode: [3840, 2160]` and
    /// `size: [1800, 3200]`.
    #[serde(default)]
    pub mode: [u32; 2],
    /// The rate the monitor scans out at, in mHz, as `wl_output.mode` states
    /// it. Zero when unknown.
    #[serde(default)]
    pub refresh_mhz: u32,
    /// Whether the monitor scans out with a variable refresh rate.
    #[serde(default)]
    pub adaptive_sync: AdaptiveSync,
    /// Whether the monitor is driven in HDR10. See `docs/COLOR.md`.
    #[serde(default)]
    pub hdr: DisplayHdr,
    /// The panel's peak luminance from its EDID, in cd/m². Zero when it
    /// reports none.
    #[serde(default)]
    pub peak_luminance: u32,
    /// While [`DisplayHdr::On`], the luminance SDR content's white is shown
    /// at, in cd/m². Zero otherwise.
    #[serde(default)]
    pub sdr_white: u32,
    /// How the monitor is rotated.
    #[serde(default)]
    pub transform: DisplayTransform,
}

/// Whether a monitor scans out with a variable refresh rate (adaptive sync,
/// FreeSync, G-Sync Compatible). See `docs/DISPLAYS.md#adaptive-sync`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdaptiveSync {
    /// The monitor, its connector or its driver cannot, or the desktop runs
    /// in a window.
    #[default]
    Unsupported,
    /// It can, and is not: its profile does not ask for it, or the driver
    /// refused it.
    Off,
    /// It is.
    On,
}

/// A lit monitor as a display profile names it. See
/// [`HostMessage::Monitors`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorInfo {
    /// Every name a profile's `display` matches it by: its output name first,
    /// then its connector, and its EDID name with the maker as a three-letter
    /// code and spelled out.
    pub names: Vec<String>,
    /// Whether it is driven in HDR10.
    pub hdr: DisplayHdr,
}

/// A display as `domicile list-displays` prints it. See
/// [`HostMessage::DisplayList`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedDisplay {
    #[serde(flatten)]
    pub display: DisplayInfo,
    /// Every name `sleep-displays` and a profile's `display` take for it, its
    /// output name first.
    pub names: Vec<String>,
    /// Off when slept or blanked.
    pub lit: bool,
}

/// One command a shell runs, as `domicile list-shell-commands` prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCommandHelp {
    /// Its words, such as `focus left|right|up|down` or `workspace <name>`.
    pub usage: String,
    /// What it does, in a sentence.
    pub description: String,
}

/// One key or gesture a shell binds, as `domicile list-bindings` prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellBinding {
    /// The binding mode it is in; `default` until a binding changes mode.
    pub mode: String,
    /// The chord (`Meta+Shift+l`), touchpad gesture (`swipe:3:left`) or
    /// touchscreen edge swipe (`edge:left`), in the shell's one spelling.
    pub chord: String,
    /// What it runs, as words: `send-shell focus left`, `mode resize`, or
    /// `hold <press> / <release>`.
    pub action: String,
}

/// How the desktop is, as `domicile status` prints it. See
/// [`HostMessage::Status`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopStatus {
    pub theme: Theme,
    pub locked: bool,
    /// The config's name for the keymap typed on; `None` before the
    /// compositor lists the keymaps.
    pub keymap: Option<String>,
    /// Every monitor is off: blanked while idle, or slept together.
    pub screens_off: bool,
    /// What keeps the screens on, one name per idle inhibitor.
    pub held_awake_by: Vec<String>,
    /// What records or controls the desktop: screen casts, recordings, remote
    /// desktop and input capture sessions.
    pub capturing: Vec<Capturing>,
}

/// Who draws a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowKind {
    /// A Wayland client.
    Native,
    /// The engine: a browser or app window.
    Browser,
}

/// A window as `domicile list-windows` prints it. See
/// [`HostMessage::WindowList`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListedWindow {
    /// Its `ext-foreign-toplevel-list-v1` identifier.
    pub id: String,
    pub kind: WindowKind,
    /// Empty when it has none.
    pub title: String,
    /// A native window's desktop entry id, or a browser window's app id.
    pub app: Option<String>,
    /// A native window's process.
    pub pid: Option<i32>,
    /// A native window's size, logical.
    pub size: Option<[f64; 2]>,
    /// It has the keyboard. Only a native window can: the shell's page holds
    /// the keyboard for browser windows.
    pub focused: bool,
    /// It asked for the keyboard and was refused.
    pub urgent: bool,
    /// A browser window's address, or the one it is opening.
    pub url: Option<String>,
    /// A browser window in the off-the-record profile.
    pub private: bool,
    /// A browser window's id in the engine, which `domicile devtools` sends
    /// to.
    pub engine_id: Option<String>,
    /// The views a browser window holds and shows, bottom first: an Electron
    /// app's `WebContentsView`s, each a page of its own.
    #[serde(default)]
    pub views: Vec<ListedView>,
}

/// A view a [`ListedWindow`] holds: a page the app placed in the window's
/// page, which `domicile devtools --view` drives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedView {
    /// Its id in the engine.
    pub id: String,
    /// Its top-left corner in the window's page, in that page's CSS pixels.
    pub position: [i32; 2],
    /// In CSS pixels.
    pub size: [i32; 2],
}

/// What a [`ChromeMessage::ActOnWindow`] does to a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowAct {
    /// Ask the shell to show and focus it, as the window's own activation
    /// request does ([`HostMessage::FocusRequested`]). The shell decides.
    Focus,
    /// Ask its client to close it, as its close button does. The client may
    /// refuse, for example to ask about unsaved work.
    Close,
    /// Kill its client's process with `SIGKILL`, and every window it has.
    Kill,
}

/// What a [`ChromeMessage::ConfigureDisplay`] changes about a monitor. Each
/// field left out stays as before; `reset` first drops every earlier change,
/// back to what the config says.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DisplayChange {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
    /// Lit, or turned off and left out of the desktop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Width and height in pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<(u32, u32)>,
    /// In Hz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    /// Its top-left corner in the desktop, in logical pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<(i32, i32)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<DisplayTransform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_sync: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hdr: Option<bool>,
    /// The nits SDR white is shown at with HDR on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdr_white: Option<u32>,
}

/// What a [`ChromeMessage::Watch`] hears about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WatchTopic {
    /// [`HostMessage::WindowList`].
    Windows,
    /// [`HostMessage::DisplayList`].
    Displays,
    /// [`HostMessage::InputList`].
    Inputs,
    /// [`HostMessage::Status`].
    Status,
}

/// An input device as `domicile list-inputs` prints it. See
/// [`HostMessage::InputList`]. A device that is both, like a keyboard with a
/// touchpad, is listed once for each kind under one id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedInput {
    /// The engine's id for it, while it stays plugged in.
    pub id: i32,
    /// What its driver calls it.
    pub name: String,
    pub kind: InputKind,
    pub connection: InputConnection,
    /// Its device under `/sys`, or empty when unknown.
    pub sys_path: String,
    /// Its USB or Bluetooth vendor id, or 0.
    pub vendor: u16,
    /// Its USB or Bluetooth product id, or 0.
    pub product: u16,
}

/// What an input device is. See [`ListedInput`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputKind {
    Keyboard,
    Mouse,
    Touchpad,
    Touchscreen,
    PointingStick,
    Tablet,
    /// Read for its keys or switches alone, like a power button or a lid.
    Other,
}

/// How an input device is attached. See [`ListedInput`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputConnection {
    /// Built into the machine.
    Internal,
    Usb,
    Bluetooth,
    Unknown,
}

/// Whether a monitor is driven in HDR10: BT.2020 primaries with the PQ
/// transfer function. See `docs/COLOR.md`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DisplayHdr {
    /// Its EDID takes no PQ, its connector cannot scan out in 10 bits, or the
    /// desktop runs in a window.
    #[default]
    Unsupported,
    /// It can, and is not: its profile does not ask for it.
    Off,
    /// It is.
    On,
}

/// How a monitor is rotated, as written in the config file.
///
/// Matches the `wl_output.transform` rotations, which count counterclockwise:
/// `rotate-90` turns content a quarter counterclockwise, for a panel turned a
/// quarter clockwise. kanshi and sway use the same numbers.
///
/// Renamed per variant because serde's kebab-case would write `rotate270`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisplayTransform {
    #[default]
    #[serde(rename = "normal")]
    Normal,
    /// Content turned a quarter counterclockwise.
    #[serde(rename = "rotate-90")]
    Rotate90,
    #[serde(rename = "rotate-180")]
    Rotate180,
    /// Content turned a quarter clockwise, for a panel standing on its left
    /// side.
    #[serde(rename = "rotate-270")]
    Rotate270,
}

impl DisplayTransform {
    /// Whether this rotation swaps width and height, i.e. how `mode` maps to
    /// `size`.
    pub fn swaps_axes(self) -> bool {
        match self {
            Self::Normal | Self::Rotate180 => false,
            Self::Rotate90 | Self::Rotate270 => true,
        }
    }
}

/// A cursor a client can ask for, named as the CSS `cursor` keyword the chrome
/// applies. These are the shapes `wp_cursor_shape_v1` defines, plus
/// [`CursorShape::None`] for a client that hides the cursor entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CursorShape {
    None,
    Default,
    ContextMenu,
    Help,
    Pointer,
    Progress,
    Wait,
    Cell,
    Crosshair,
    Text,
    VerticalText,
    Alias,
    Copy,
    Move,
    NoDrop,
    NotAllowed,
    Grab,
    Grabbing,
    EResize,
    NResize,
    NeResize,
    NwResize,
    SResize,
    SeResize,
    SwResize,
    WResize,
    EwResize,
    NsResize,
    NeswResize,
    NwseResize,
    ColResize,
    RowResize,
    AllScroll,
    ZoomIn,
    ZoomOut,
}

/// How much a part of the desktop logs, from least to most.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    /// The name `domicile set-log-level` takes.
    pub fn name(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }
}

/// An area of the desktop whose logs can be turned up on their own. Each part
/// (compositor, engine, shell) maps it to the code it logs from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Subsystem {
    Input,
    Displays,
    Windows,
    Rendering,
    Cast,
    Portals,
    Idle,
    Clipboard,
    Notifications,
    Electron,
    Agents,
    Shell,
    Session,
}

impl Subsystem {
    /// Every subsystem, in the order help lists them.
    pub const ALL: [Subsystem; 13] = [
        Subsystem::Input,
        Subsystem::Displays,
        Subsystem::Windows,
        Subsystem::Rendering,
        Subsystem::Cast,
        Subsystem::Portals,
        Subsystem::Idle,
        Subsystem::Clipboard,
        Subsystem::Notifications,
        Subsystem::Electron,
        Subsystem::Agents,
        Subsystem::Shell,
        Subsystem::Session,
    ];

    /// The name `domicile set-log-level` takes.
    pub fn name(self) -> &'static str {
        match self {
            Subsystem::Input => "input",
            Subsystem::Displays => "displays",
            Subsystem::Windows => "windows",
            Subsystem::Rendering => "rendering",
            Subsystem::Cast => "cast",
            Subsystem::Portals => "portals",
            Subsystem::Idle => "idle",
            Subsystem::Clipboard => "clipboard",
            Subsystem::Notifications => "notifications",
            Subsystem::Electron => "electron",
            Subsystem::Agents => "agents",
            Subsystem::Shell => "shell",
            Subsystem::Session => "session",
        }
    }

    /// What it covers, for help and the Settings app.
    pub fn description(self) -> &'static str {
        match self {
            Subsystem::Input => "Keyboards, pointers, touch, gestures and input methods",
            Subsystem::Displays => "Monitors, modes, scale, color and night light",
            Subsystem::Windows => "App windows, popups, focus and launching apps",
            Subsystem::Rendering => "Frames, buffers, page flips and latency",
            Subsystem::Cast => "Screen sharing, screenshots and casting",
            Subsystem::Portals => "Desktop portals and their dialogs",
            Subsystem::Idle => "Idle, the screen lock and sleep",
            Subsystem::Clipboard => "Copy and paste",
            Subsystem::Notifications => "Notifications and the system tray",
            Subsystem::Electron => "Electron apps on the engine",
            Subsystem::Agents => "Agents that use the desktop",
            Subsystem::Shell => "The shell and its connection to the desktop",
            Subsystem::Session => "Starting, stopping and the login session",
        }
    }
}

/// The log levels set at runtime, over the starting ones.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLevels {
    /// The level for everything Domicile logs, or the starting level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<LogLevel>,
    /// Levels for single subsystems, over `all`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub subsystems: std::collections::BTreeMap<Subsystem, LogLevel>,
}

/// The desktop's color theme.
///
/// Mirrors `domicile_config::ThemeMode` rather than sharing it, to keep this
/// crate serde-only. There is no "follow the system" variant because Domicile
/// is the system.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    /// The default when the config sets none.
    #[default]
    Dark,
    Light,
}

/// One system tray icon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrayItem {
    /// The id [`ChromeMessage::ActivateTrayItem`] uses.
    ///
    /// The StatusNotifierItem `Id`, which survives an application restart so a
    /// shell can keep the icon's position. Duplicates get `#2`, `#3` and so
    /// on; an item with no `Id` uses its bus name and object path.
    pub id: String,
    /// The icon's label: its tooltip title, else `Title`, else `Id`. Never
    /// empty.
    pub title: String,
    /// The icon as a `data:` URL, using the attention icon when the item needs
    /// attention. Absent when none could be drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// The bus name the item answers on, unique or well-known.
    pub bus: String,
    /// The object path of its `com.canonical.dbusmenu` menu, on `bus`: its
    /// `Menu` property. Absent when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu: Option<String>,
    /// Its `ItemIsMenu` property: the item only has a menu, so a primary click
    /// should open it rather than send `Activate`.
    pub item_is_menu: bool,
}

/// Which StatusNotifierItem action a tray click requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayAction {
    /// `Activate`: the primary button, usually raising the app's window.
    Primary,
    /// `SecondaryActivate`: the middle button.
    Secondary,
    /// `ContextMenu`: the secondary button, asking the app for its menu.
    Context,
}

/// One notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notification {
    /// The id `Notify` returned, used by
    /// [`ChromeMessage::DismissNotifications`] and
    /// [`ChromeMessage::InvokeNotificationAction`]. A replaced notification
    /// keeps its id.
    pub id: u32,
    /// The sender's name. May be empty.
    pub app_name: String,
    /// The one-line summary. May be empty.
    pub summary: String,
    /// The body as plain text; the compositor strips the spec's markup.
    pub body: String,
    /// The notification's image, else its application's icon, as a `data:`
    /// URL. Absent when neither could be drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub urgency: Urgency,
    /// Its buttons, in the application's order. The `default` action is
    /// excluded; see [`Notification::clickable`]. An `inline-reply` action is
    /// a reply field labeled `label`, answered with
    /// [`ChromeMessage::ReplyToNotification`].
    pub actions: Vec<NotificationAction>,
    /// Whether the application offered a `default` action.
    pub clickable: bool,
    /// Requested display time in milliseconds; `0` means until dismissed.
    /// Absent when left to the server (the shell).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    /// Arrival or last replacement time, in Unix milliseconds on the
    /// compositor's clock.
    pub time: u64,
    /// The browser window whose page sent it, as the engine names it in
    /// `x-domicile-browser-window`. Absent for anything else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_window: Option<String>,
}

/// One button of a [`Notification`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationAction {
    /// The key [`ChromeMessage::InvokeNotificationAction`] uses.
    pub key: String,
    /// What the button says.
    pub label: String,
}

/// A notification's `urgency` hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Urgency {
    Low,
    #[default]
    Normal,
    /// Something the user should not miss, such as a nearly empty battery.
    Critical,
}

/// Version negotiation failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("incompatible protocol version: host speaks {host}, chrome speaks {chrome}")]
pub struct VersionMismatch {
    pub host: u32,
    pub chrome: u32,
}

/// Negotiate a protocol version against a chrome that speaks `chrome_version`.
///
/// Requires an exact match; see [`PROTOCOL_VERSION`].
pub fn negotiate(chrome_version: u32) -> Result<u32, VersionMismatch> {
    if chrome_version == PROTOCOL_VERSION {
        Ok(PROTOCOL_VERSION)
    } else {
        Err(VersionMismatch {
            host: PROTOCOL_VERSION,
            chrome: chrome_version,
        })
    }
}

#[cfg(test)]
mod wire_names {
    use super::*;

    /// The exact JSON the SDK sends for a theme change.
    ///
    /// The chrome-to-host direction has no shared fixture in `wire/`, so these
    /// tests are the only check that the SDK's spelling matches this enum.
    #[test]
    fn the_theme_the_sdk_sends_parses() {
        let sent = r#"{"type":"set_theme","theme":"light"}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::SetTheme {
                theme: Theme::Light
            }
        );
    }

    /// The exact JSON the SDK sends once a page has captured its frame.
    #[test]
    fn the_capture_the_sdk_sends_parses() {
        let sent = r#"{"type":"theme_captured","theme":"light"}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::ThemeCaptured {
                theme: Theme::Light
            }
        );
    }

    /// The exact JSON the SDK sends for a tray icon click.
    #[test]
    fn the_tray_click_the_sdk_sends_parses() {
        let sent =
            r#"{"type":"activate_tray_item","id":":1.42/StatusNotifierItem","action":"context"}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::ActivateTrayItem {
                id: ":1.42/StatusNotifierItem".to_string(),
                action: TrayAction::Context,
            }
        );
    }

    /// The exact JSON the SDK sends to dismiss notifications.
    #[test]
    fn the_dismissal_the_sdk_sends_parses() {
        let sent = r#"{"type":"dismiss_notifications","ids":[7,8]}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::DismissNotifications { ids: vec![7, 8] }
        );
    }

    /// The exact JSON the SDK sends for a notification button press.
    #[test]
    fn the_notification_action_the_sdk_sends_parses() {
        let sent = r#"{"type":"invoke_notification_action","id":7,"action":"reply"}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::InvokeNotificationAction {
                id: 7,
                action: "reply".to_string(),
            }
        );
    }

    /// The exact JSON the SDK sends for an inline reply.
    #[test]
    fn the_notification_reply_the_sdk_sends_parses() {
        let sent = r#"{"type":"reply_to_notification","id":7,"text":"On my way"}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::ReplyToNotification {
                id: 7,
                text: "On my way".to_string(),
            }
        );
    }

    /// The exact JSON the SDK sends for the desktop size.
    ///
    /// `chrome-message.ts` spells message types as literals and serde derives
    /// them here, so a mismatch would otherwise surface only at runtime, as an
    /// unparseable message and a desktop that never resizes.
    #[test]
    fn the_desktop_size_the_sdk_sends_parses() {
        let sent = r#"{"type":"set_desktop_size","size":[1600,1200]}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the SDK's own wire form"),
            ChromeMessage::SetDesktopSize {
                size: [1600.0, 1200.0]
            }
        );
    }

    /// The exact JSON the engine's `setAppBounds` sends.
    #[test]
    fn an_apps_bounds_the_engine_sends_parse() {
        let sent =
            r#"{"type":"set_app_bounds","app_id":"7","position":[1920.5,30],"size":[800,600]}"#;
        assert_eq!(
            serde_json::from_str::<ChromeMessage>(sent).expect("the engine's own wire form"),
            ChromeMessage::SetAppBounds {
                app_id: "7".to_string(),
                position: [1920.5, 30.0],
                size: [800.0, 600.0],
            }
        );
    }
}
