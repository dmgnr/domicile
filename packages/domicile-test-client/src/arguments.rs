//! The client's command line.
//!
//! Parsing is strict: unknown, repeated and empty arguments are errors, so a
//! check never gets a different window than it asked for.
//!
//! The initial window size is a constant in `window.rs`; no check needs to set
//! it.

use std::ffi::OsString;

use wayland_client::protocol::wl_output::Transform;

/// What to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Arguments {
    /// The toplevel's title, which checks use to tell windows apart.
    pub title: String,
    /// Whether to print the protocol messages this client receives.
    pub trace: bool,
    /// Whether to resize to the configured size instead of keeping its own.
    ///
    /// Off by default because most checks rely on a fixed window size. On, the
    /// client behaves like the chrome, which the compositor sizes to the
    /// desktop (see `e2e-chrome-fills-the-desktop.sh`).
    pub follow_configure: bool,

    /// Whether the window is half-transparent.
    ///
    /// Lets a check tell the client's own pixels apart from something painted
    /// over the window.
    pub translucent: bool,

    /// When to request focus with `xdg_activation_v1`, if at all.
    pub ask_for_focus: Option<AskForFocus>,

    /// Text to offer on the clipboard.
    ///
    /// A Wayland client serves every paste of its own selection, so clipboard
    /// checks need a real client to hold the data.
    pub copy: Option<String>,

    /// A summary to send `org.freedesktop.Notifications` once the keyboard
    /// first enters, as a chat app does, with a press as its only action.
    ///
    /// After the enter, so the window getting the keyboard does not read it
    /// (the compositor clears an app's notifications then).
    ///
    /// The bus and the Wayland socket share the client's process, as in
    /// Electron, so a press can be traced back to the window.
    pub notify: Option<String>,

    /// Whether to show a tray icon (`org.kde.StatusNotifierItem`) on the
    /// session bus, as a chat app does, tracing its clicks and the tokens
    /// handed to it.
    ///
    /// The bus and the Wayland socket share the client's process, as in
    /// Electron, so a click can be traced back to the window.
    pub tray: bool,

    /// Text to offer on the primary (middle-click) selection.
    ///
    /// Separate from [`copy`](Self::copy) so checks can catch a compositor that
    /// mixes up the two selections.
    pub copy_primary: Option<String>,

    /// When to take a `zwp_idle_inhibit_manager_v1` inhibitor on its surface,
    /// if at all.
    pub hold_the_screens_on: Option<HoldTheScreensOn>,

    /// When to take a `zwp_keyboard_shortcuts_inhibitor_v1` on its surface,
    /// as a remote desktop viewer does, if at all.
    pub inhibit_shortcuts: Option<TakeTheShortcuts>,

    /// Whether to stay connected after its window is closed.
    ///
    /// On, the client destroys the `xdg_toplevel` but keeps the connection, so
    /// checks can tell a closed window apart from a client disconnecting.
    pub outlive_its_window: bool,

    /// Whether to ring `xdg_system_bell_v1` once mapped: once with its
    /// surface, then once with none.
    pub ring_the_bell: bool,

    /// Whether to read and trace every offer on either selection.
    ///
    /// Selections are only offered to the focused client, so this only works
    /// once the window has keyboard focus.
    pub paste: bool,

    /// Whether to open a popup over the window once it is up.
    ///
    /// See [`crate::window::POPUP`] for its placement and color.
    pub popup: bool,

    /// Whether the popup calls `xdg_popup.grab` before its first commit, as a
    /// menu does. Implies `popup`.
    pub popup_grab: bool,

    /// Whether the popup moves once it has drawn, as a menu does when its
    /// anchor scrolls: `xdg_popup.reposition` to
    /// [`crate::window::POPUP_MOVED`], drawn anew at its new size. Implies
    /// `popup`.
    pub repositioned_popup: bool,

    /// The page anchor to ask for (`domicile_toplevel_anchor_v1.set_anchor`),
    /// before the window's first commit.
    pub anchor: Option<String>,

    /// Whether each press opens a menu over what it pressed, the window or a
    /// menu, whose positioner lets it slide on both axes.
    ///
    /// Opened on a press, as a menu is, so the shell has placed the window
    /// first. See [`crate::window::POPUP`] for its placement.
    pub sliding_menu: bool,

    /// Whether the client draws its own cursor: a 4 by 4 surface in
    /// [`crate::window::POPUP_COLOR`] with its hotspot at 1, 2, set when the
    /// pointer enters, and redrawn 6 by 6 at each press.
    pub cursor_surface: bool,
    /// What a press on the window asks the desktop to start, as a client that
    /// draws its own title bar and edges does: a move, or a resize by an edge.
    /// `move-after-release` asks only once the button is up, as a slow client
    /// can, with a press the desktop must not honor.
    pub ask_to_drag: Option<AskToDrag>,

    /// Whether the client asks, when the pointer first enters its window, to
    /// lock the pointer there or confine it to the window, as a game does. A
    /// persistent ask over the whole window, unless `constrain_region` names
    /// part of it.
    pub constrain_pointer: Option<ConstrainPointer>,
    /// The part of the window `constrain_pointer` asks for, as
    /// `(x, y, width, height)` in surface-local units.
    pub constrain_region: Option<(i32, i32, i32, i32)>,

    /// Whether to open a bubble over the window once it is up: a desync
    /// `wl_subsurface`, as Chromium draws an extension popup.
    ///
    /// See [`crate::window::BUBBLE`] for its placement.
    pub bubble: bool,

    /// Whether to open a `--bubble` whose input region is empty, as Firefox's
    /// content subsurface is: the pointer over it belongs to the window.
    pub bubble_without_input: bool,

    /// Whether to scroll a stripe down the window, a step each frame, with a
    /// sync `wl_subsurface` bubble moved onto it in the same commit, as a page
    /// scrolls under an anchored popup.
    ///
    /// See [`crate::window::SCROLLING_BUBBLE`] for its geometry.
    pub scrolling_bubble: bool,

    /// Whether a `--scrolling-bubble` is moved a frame late: each commit puts
    /// it where the stripe was the frame before, off its content. The control
    /// of `guard-scrolling-bubble.sh`.
    pub late_bubble: bool,

    /// Whether to open a second toplevel once the window is up, and make it
    /// the window's dialog (`xdg_toplevel.set_parent`) after it first draws.
    ///
    /// See [`crate::window::POPUP`] for its size and color.
    pub dialog: bool,
    /// Size limits for `xdg_toplevel.set_min_size` and `set_max_size`, in
    /// surface pixels. `0` on an axis means no limit.
    pub min_size: Option<(i32, i32)>,
    pub max_size: Option<(i32, i32)>,

    /// The size to redraw at after the first frame, in surface pixels, as a
    /// client that picks its own size does.
    pub resize_to: Option<(u32, u32)>,

    /// The `wp_viewport.set_source` to draw with, if any: the buffer's
    /// top-left `WIDTHxHEIGHT`, in surface pixels, with no destination.
    pub viewport_source: Option<(u32, u32)>,

    /// The `wp_viewport.set_destination` to set after the first frame, if any.
    ///
    /// The client commits it without attaching a buffer, and then stops
    /// drawing, so only the viewport says the window changed size.
    pub viewport_to: Option<(u32, u32)>,

    /// The `wl_surface.set_buffer_transform` to draw with, if any.
    ///
    /// The buffer is drawn turned, half [`crate::window::TURNED_COLORS`]`[0]`
    /// and half `[1]` across, so a check can tell which way it is shown.
    pub buffer_transform: Option<Transform>,

    /// The maximize or fullscreen request to make on its first configure, if
    /// any. `Fullscreen` names the first output the client bound.
    pub ask_to: Option<AskTo>,

    /// Whether to bind `xdg_wm_base` at version 1, as a client too old for
    /// tiled states does.
    pub xdg_wm_base_v1: bool,

    /// Whether to bind `wl_seat` at version 7 rather than 5.
    ///
    /// Smithay sends the keymap as a sealed memfd from version 7 and as a
    /// temporary file below it.
    pub wl_seat_v7: bool,

    /// Whether to leave `wl_touch` unbound, as a client with no touch support
    /// does, so the compositor gives it a finger as the pointer.
    pub no_touch: bool,

    /// Whether to be a text editor: a `zwp_text_input_v3` that enables on
    /// each enter, traces what an input method sends it, and moves its text
    /// cursor ([`crate::CARET`]) as text is committed.
    pub text_input: bool,

    /// The 10-bit or half-float `wl_shm` format to draw in, if any.
    ///
    /// The window is [`crate::window::DEEP_COLOR`] in that format, so a check
    /// can read back that the format reached the page in the right colors.
    pub format: Option<DeepFormat>,
}

/// A `wl_shm` format with more than 8 bits a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepFormat {
    Abgr2101010,
    Xbgr2101010,
    Abgr16161616f,
    Xbgr16161616f,
}

/// An `xdg_toplevel` request about the window's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskTo {
    Maximize,
    Unmaximize,
    Fullscreen,
    Unfullscreen,
    Minimize,
}

/// The interactive drag a press asks for. See
/// [`Arguments::ask_to_drag`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskToDrag {
    Move,
    ResizeBottomRight,
    MoveAfterRelease,
}

/// What the client asks the pointer to do. See
/// [`Arguments::constrain_pointer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConstrainPointer {
    Lock,
    Confine,
}

/// When the client takes its idle inhibitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldTheScreensOn {
    /// After the surface becomes a window, as a video player does.
    OnItsWindow,
    /// Before the surface has a role.
    ///
    /// The protocol allows this. A desktop must not honor it, or a client with
    /// no visible window could keep the screens on.
    BeforeItHasAWindow,
}

/// When the client takes its keyboard shortcuts inhibitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakeTheShortcuts {
    /// After the surface becomes a window.
    OnItsWindow,
    /// Before the surface has a role.
    BeforeItHasAWindow,
}

/// When the client asks for the keyboard, and with which serial.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskForFocus {
    /// Once its window is up, without a serial.
    OnceMapped,
    /// When the keyboard enters it, with that `enter`'s serial: a request the
    /// user's own focus change backs.
    WhenEntered,
    /// When the keyboard leaves it, with the serial of the `enter` before: a
    /// window taking the keyboard back after the user moved on.
    WhenLeft,
}

/// Why a command line was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgumentError {
    #[error("{flag} needs a value after it")]
    NeedsValue { flag: String },

    #[error("{flag} was given an empty value")]
    EmptyValue { flag: String },

    #[error("{flag} was given more than once")]
    Repeated { flag: String },

    #[error("{flag} wants WIDTHxHEIGHT, not {value}")]
    NotASize { flag: String, value: String },

    #[error("--buffer-transform wants a wl_output.transform name, not {value}")]
    NotATransform { value: String },

    #[error(
        "--ask-to wants maximize, unmaximize, fullscreen, unfullscreen or minimize, not {value}"
    )]
    NotAWindowRequest { value: String },

    #[error("--ask-to-drag wants move, bottom-right or move-after-release, not {value}")]
    NotADrag { value: String },

    #[error("--constrain-pointer wants lock or confine, not {value}")]
    NotAConstraint { value: String },

    #[error("--constrain-region wants WIDTHxHEIGHT+X+Y, not {value}")]
    NotARegion { value: String },

    #[error(
        "--format wants abgr2101010, xbgr2101010, abgr16161616f or xbgr16161616f, not {value}"
    )]
    NotADeepFormat { value: String },

    #[error("unknown argument {argument}")]
    Unknown { argument: String },
}

/// Parse the client's command line.
pub fn arguments(args: impl IntoIterator<Item = OsString>) -> Result<Arguments, ArgumentError> {
    let mut title = None;
    let mut trace = None;
    let mut translucent = None;
    let mut follow_configure = None;
    let mut ask_for_focus = None;
    let mut hold_the_screens_on = None;
    let mut inhibit_shortcuts = None;
    let mut outlive_its_window = None;
    let mut ring_the_bell = None;
    let mut copy = None;
    let mut copy_primary = None;
    let mut notify = None;
    let mut tray = None;
    let mut paste = None;
    let mut popup = None;
    let mut popup_grab = None;
    let mut repositioned_popup = None;
    let mut anchor = None;
    let mut sliding_menu = None;
    let mut cursor_surface = None;
    let mut ask_to_drag = None;
    let mut constrain_pointer = None;
    let mut constrain_region = None;
    let mut bubble = None;
    let mut bubble_without_input = None;
    let mut scrolling_bubble = None;
    let mut late_bubble = None;
    let mut dialog = None;
    let mut min_size = None;
    let mut max_size = None;
    let mut resize_to = None;
    let mut viewport_source = None;
    let mut viewport_to = None;
    let mut buffer_transform = None;
    let mut ask_to = None;
    let mut xdg_wm_base_v1 = None;
    let mut wl_seat_v7 = None;
    let mut no_touch = None;
    let mut text_input = None;
    let mut format = None;

    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        let flag = argument.to_string_lossy().into_owned();
        match flag.as_str() {
            "--title" => {
                take(&mut title, &flag, value(&mut args, &flag)?)?;
            }
            "--trace" => {
                take(&mut trace, &flag, true)?;
            }
            "--translucent" => {
                take(&mut translucent, &flag, true)?;
            }
            "--follow-configure" => {
                take(&mut follow_configure, &flag, true)?;
            }
            "--ask-for-focus" => {
                take(&mut ask_for_focus, &flag, AskForFocus::OnceMapped)?;
            }
            "--ask-for-focus-when-entered" => {
                take(&mut ask_for_focus, &flag, AskForFocus::WhenEntered)?;
            }
            "--ask-for-focus-when-left" => {
                take(&mut ask_for_focus, &flag, AskForFocus::WhenLeft)?;
            }
            "--hold-the-screens-on" => {
                take(
                    &mut hold_the_screens_on,
                    &flag,
                    HoldTheScreensOn::OnItsWindow,
                )?;
            }
            "--hold-the-screens-on-before-it-has-a-window" => {
                take(
                    &mut hold_the_screens_on,
                    &flag,
                    HoldTheScreensOn::BeforeItHasAWindow,
                )?;
            }
            "--inhibit-shortcuts" => {
                take(&mut inhibit_shortcuts, &flag, TakeTheShortcuts::OnItsWindow)?;
            }
            "--inhibit-shortcuts-before-it-has-a-window" => {
                take(
                    &mut inhibit_shortcuts,
                    &flag,
                    TakeTheShortcuts::BeforeItHasAWindow,
                )?;
            }
            "--outlive-its-window" => {
                take(&mut outlive_its_window, &flag, true)?;
            }
            "--ring-the-bell" => {
                take(&mut ring_the_bell, &flag, true)?;
            }
            "--copy" => {
                take(&mut copy, &flag, value(&mut args, &flag)?)?;
            }
            "--copy-primary" => {
                take(&mut copy_primary, &flag, value(&mut args, &flag)?)?;
            }
            "--notify" => {
                take(&mut notify, &flag, value(&mut args, &flag)?)?;
            }
            "--tray" => {
                take(&mut tray, &flag, true)?;
            }
            "--paste" => {
                take(&mut paste, &flag, true)?;
            }
            "--popup" => {
                take(&mut popup, &flag, true)?;
            }
            "--popup-grab" => {
                take(&mut popup_grab, &flag, true)?;
            }
            "--repositioned-popup" => {
                take(&mut repositioned_popup, &flag, true)?;
            }
            "--anchor" => {
                take(&mut anchor, &flag, value(&mut args, &flag)?)?;
            }
            "--sliding-menu" => {
                take(&mut sliding_menu, &flag, true)?;
            }
            "--cursor-surface" => {
                take(&mut cursor_surface, &flag, true)?;
            }
            "--ask-to-drag" => {
                take(&mut ask_to_drag, &flag, drag(&mut args, &flag)?)?;
            }
            "--constrain-pointer" => {
                let stated = value(&mut args, &flag)?;
                let constraint = match stated.as_str() {
                    "lock" => ConstrainPointer::Lock,
                    "confine" => ConstrainPointer::Confine,
                    _ => return Err(ArgumentError::NotAConstraint { value: stated }),
                };
                take(&mut constrain_pointer, &flag, constraint)?;
            }
            "--constrain-region" => {
                take(&mut constrain_region, &flag, region(&mut args, &flag)?)?;
            }
            "--bubble" => {
                take(&mut bubble, &flag, true)?;
            }
            "--bubble-without-input" => {
                take(&mut bubble_without_input, &flag, true)?;
            }
            "--scrolling-bubble" => {
                take(&mut scrolling_bubble, &flag, true)?;
            }
            "--late-bubble" => {
                take(&mut late_bubble, &flag, true)?;
            }
            "--dialog" => {
                take(&mut dialog, &flag, true)?;
            }
            "--min-size" => {
                take(&mut min_size, &flag, size(&mut args, &flag)?)?;
            }
            "--max-size" => {
                take(&mut max_size, &flag, size(&mut args, &flag)?)?;
            }
            "--resize-to" => {
                take(&mut resize_to, &flag, size(&mut args, &flag)?)?;
            }
            "--viewport-source" => {
                take(&mut viewport_source, &flag, size(&mut args, &flag)?)?;
            }
            "--viewport-to" => {
                take(&mut viewport_to, &flag, size(&mut args, &flag)?)?;
            }
            "--format" => {
                take(&mut format, &flag, deep_format(&mut args, &flag)?)?;
            }
            "--buffer-transform" => {
                take(&mut buffer_transform, &flag, turn(&mut args, &flag)?)?;
            }
            "--ask-to" => {
                take(&mut ask_to, &flag, window_request(&mut args, &flag)?)?;
            }
            "--xdg-wm-base-v1" => {
                take(&mut xdg_wm_base_v1, &flag, true)?;
            }
            "--wl-seat-v7" => {
                take(&mut wl_seat_v7, &flag, true)?;
            }
            "--no-touch" => {
                take(&mut no_touch, &flag, true)?;
            }
            "--text-input" => {
                take(&mut text_input, &flag, true)?;
            }
            _ => return Err(ArgumentError::Unknown { argument: flag }),
        }
    }

    Ok(Arguments {
        title: title.unwrap_or_else(|| "domicile-test-client".to_string()),
        follow_configure: follow_configure.unwrap_or(false),
        trace: trace.unwrap_or(false),
        translucent: translucent.unwrap_or(false),
        ask_for_focus,
        hold_the_screens_on,
        inhibit_shortcuts,
        outlive_its_window: outlive_its_window.unwrap_or(false),
        ring_the_bell: ring_the_bell.unwrap_or(false),
        copy,
        copy_primary,
        notify,
        tray: tray.unwrap_or(false),
        paste: paste.unwrap_or(false),
        popup: popup.unwrap_or(false)
            || popup_grab.unwrap_or(false)
            || repositioned_popup.unwrap_or(false),
        popup_grab: popup_grab.unwrap_or(false),
        repositioned_popup: repositioned_popup.unwrap_or(false),
        anchor,
        sliding_menu: sliding_menu.unwrap_or(false),
        cursor_surface: cursor_surface.unwrap_or(false),
        ask_to_drag,
        constrain_pointer,
        constrain_region,
        bubble: bubble.unwrap_or(false),
        bubble_without_input: bubble_without_input.unwrap_or(false),
        scrolling_bubble: scrolling_bubble.unwrap_or(false),
        late_bubble: late_bubble.unwrap_or(false),
        dialog: dialog.unwrap_or(false),
        min_size,
        max_size,
        resize_to,
        viewport_source,
        viewport_to,
        buffer_transform,
        ask_to,
        xdg_wm_base_v1: xdg_wm_base_v1.unwrap_or(false),
        wl_seat_v7: wl_seat_v7.unwrap_or(false),
        no_touch: no_touch.unwrap_or(false),
        text_input: text_input.unwrap_or(false),
        format,
    })
}

/// The value after a flag, rejecting a missing or empty one.
///
/// An empty value usually means the caller passed an unset shell variable.
fn value(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String, ArgumentError> {
    let stated = args
        .next()
        .ok_or_else(|| ArgumentError::NeedsValue {
            flag: flag.to_string(),
        })?
        .to_string_lossy()
        .into_owned();
    if stated.is_empty() {
        Err(ArgumentError::EmptyValue {
            flag: flag.to_string(),
        })
    } else {
        Ok(stated)
    }
}

/// The `WIDTHxHEIGHT` after a flag.
fn size<T: std::str::FromStr>(
    args: &mut impl Iterator<Item = OsString>,
    flag: &str,
) -> Result<(T, T), ArgumentError> {
    let stated = value(args, flag)?;
    stated
        .split_once('x')
        .and_then(|(width, height)| Some((width.parse().ok()?, height.parse().ok()?)))
        .ok_or_else(|| ArgumentError::NotASize {
            flag: flag.to_string(),
            value: stated.clone(),
        })
}

/// A rectangle written `WIDTHxHEIGHT+X+Y`, as X11 geometry is, returned as
/// `(x, y, width, height)`.
fn region(
    args: &mut impl Iterator<Item = OsString>,
    flag: &str,
) -> Result<(i32, i32, i32, i32), ArgumentError> {
    let stated = value(args, flag)?;
    let parsed = (|| {
        let (width, rest) = stated.split_once('x')?;
        let mut rest = rest.split('+');
        let height = rest.next()?;
        let x = rest.next()?;
        let y = rest.next()?;
        if rest.next().is_some() {
            return None;
        }
        Some((
            x.parse().ok()?,
            y.parse().ok()?,
            width.parse().ok()?,
            height.parse().ok()?,
        ))
    })();
    parsed.ok_or(ArgumentError::NotARegion { value: stated })
}

/// The `wl_output.transform` named after a flag: `normal`, `90`, `180`, `270`,
/// or `flipped` and `flipped-` before any of the turns.
fn turn(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<Transform, ArgumentError> {
    let stated = value(args, flag)?;
    match stated.as_str() {
        "normal" => Ok(Transform::Normal),
        "90" => Ok(Transform::_90),
        "180" => Ok(Transform::_180),
        "270" => Ok(Transform::_270),
        "flipped" => Ok(Transform::Flipped),
        "flipped-90" => Ok(Transform::Flipped90),
        "flipped-180" => Ok(Transform::Flipped180),
        "flipped-270" => Ok(Transform::Flipped270),
        _ => Err(ArgumentError::NotATransform { value: stated }),
    }
}

/// The format named after a flag.
fn deep_format(
    args: &mut impl Iterator<Item = OsString>,
    flag: &str,
) -> Result<DeepFormat, ArgumentError> {
    let stated = value(args, flag)?;
    match stated.as_str() {
        "abgr2101010" => Ok(DeepFormat::Abgr2101010),
        "xbgr2101010" => Ok(DeepFormat::Xbgr2101010),
        "abgr16161616f" => Ok(DeepFormat::Abgr16161616f),
        "xbgr16161616f" => Ok(DeepFormat::Xbgr16161616f),
        _ => Err(ArgumentError::NotADeepFormat { value: stated }),
    }
}

/// The window request named after a flag.
fn window_request(
    args: &mut impl Iterator<Item = OsString>,
    flag: &str,
) -> Result<AskTo, ArgumentError> {
    let stated = value(args, flag)?;
    match stated.as_str() {
        "maximize" => Ok(AskTo::Maximize),
        "unmaximize" => Ok(AskTo::Unmaximize),
        "fullscreen" => Ok(AskTo::Fullscreen),
        "unfullscreen" => Ok(AskTo::Unfullscreen),
        "minimize" => Ok(AskTo::Minimize),
        _ => Err(ArgumentError::NotAWindowRequest { value: stated }),
    }
}

/// Parse `--ask-to-drag`'s value.
fn drag(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<AskToDrag, ArgumentError> {
    let stated = value(args, flag)?;
    match stated.as_str() {
        "move" => Ok(AskToDrag::Move),
        "bottom-right" => Ok(AskToDrag::ResizeBottomRight),
        "move-after-release" => Ok(AskToDrag::MoveAfterRelease),
        _ => Err(ArgumentError::NotADrag { value: stated }),
    }
}

/// Store a flag's value, rejecting a repeated flag.
fn take<T>(slot: &mut Option<T>, flag: &str, stated: T) -> Result<(), ArgumentError> {
    if slot.is_some() {
        Err(ArgumentError::Repeated {
            flag: flag.to_string(),
        })
    } else {
        *slot = Some(stated);
        Ok(())
    }
}
