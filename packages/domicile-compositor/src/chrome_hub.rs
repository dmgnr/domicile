//! State shared by the Wayland thread and the chrome connection threads, and
//! the writer thread that sends every chrome what is bound for it.

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use domicile_host::bells::Bells;
use domicile_host::idle_holds::IdleHolds;
use domicile_host::idle_watches::IdleWatches;
use domicile_host::ipc::{apply_chrome_message, to_line};
use domicile_host::keymaps::Keymaps;
use domicile_host::shell_commands::ShellCommands;
use domicile_host::unlock_refusals::UnlockRefusals;
use domicile_host::window_requests::WindowRequests;
use domicile_host::Host;
use domicile_protocol::{ChromeMessage, HostMessage, Theme, WatchTopic};
use smithay::reexports::calloop::channel::Sender;

use crate::client_requests::ClientRequest;
use crate::file_indexing::Offered;
use crate::frame_report::{report, FrameTimings, FrameWindow, REPORT_EVERY};
use crate::lock::Seen;
use crate::log_levels::LogFilter;
use crate::outbound::{outbound, Outbound, OutboundReceiver, OutboundSender};
use crate::portals::Portals;
use crate::theme_turnover::chrome_key;
use crate::virtual_monitors::VirtualMonitors;
use crate::watchers::Watchers;
use crate::{eis, notifications, tray};

/// One connected chrome: where to write to it.
pub struct Chrome {
    pub writer: Arc<Mutex<UnixStream>>,
    /// The page sent `sync_frames` since its last `hello`. See
    /// [`ChromeHub::syncs_frames`].
    pub syncs_frames: bool,
}

/// State shared by the Wayland thread and the chrome connection threads.
pub struct ChromeHub {
    pub host: Mutex<Host>,
    pub chromes: Mutex<Vec<Chrome>>,
    pub request_tx: Mutex<Sender<ClientRequest>>,
    pub outbound: OutboundSender,
    pub timings: Mutex<FrameTimings>,
    /// The highest output scale to advertise.
    ///
    /// Atomic because a config reload changes it on the Wayland thread while
    /// connection threads read it.
    pub max_scale: AtomicU32,
    /// Our Wayland socket name, which spawned clients connect to.
    pub wayland_display: OsString,
    /// The nice value spawned clients and the page's processes start at: the
    /// compositor's own, before it raised its threads. See
    /// [`crate::thread_priority`].
    pub child_nice: i32,
    /// The latest file index snapshot, for answering `search_files`.
    ///
    /// Lives here because connection threads answer searches without waiting
    /// for the Wayland thread. Readers clone the `Arc` and search after
    /// releasing the lock. See [`crate::file_indexing`].
    ///
    /// `None` means no index (no `HOME`, or it was unreadable). `search_files`
    /// then answers nothing, so a launcher does not show a broken desktop as an
    /// empty home.
    pub offered: Mutex<Option<Arc<Offered>>>,
    /// The lock state, for [`answer_on_the_connection`]. Set once at startup.
    pub lock: OnceLock<Seen>,
    /// The log filter `domicile set-log-level` reloads. Set once at startup.
    pub log_filter: OnceLock<LogFilter>,
    /// The desktop portal: tells clients the theme, and takes the shell's
    /// answers to their dialogs.
    ///
    /// The theme is driven by the Wayland thread's theme turnover, not the
    /// broadcast: clients switch only after every chrome has captured its
    /// starting frame. See [`crate::portals`].
    pub portals: Portals,
    /// The tray worker that activates items.
    ///
    /// Set once after the hub exists, because the tray publishes through the
    /// hub. See [`crate::tray`]. Unset in unit tests, which have no bus.
    pub tray: OnceLock<tray::Tray>,
    /// The notification server's worker. Set once, like `tray`. See
    /// [`crate::notifications`].
    pub notifications: OnceLock<notifications::NotificationServer>,
    /// Opens EIS contexts for the RemoteDesktop and InputCapture portals. Set
    /// once, when the Wayland loop starts serving. See [`crate::eis`].
    pub eis: OnceLock<eis::Eis>,
    /// The pages listening for `domicile send-shell`, shared by every
    /// connection's `System`.
    pub shell_commands: ShellCommands,
    /// The pages watching for the desk to go idle, shared by every
    /// connection's `System`. Settled by the compositor's idle clock.
    pub idle_watches: IdleWatches,
    /// What holds the desktop awake, shared by every connection's `System`.
    /// Set by the compositor's idle clock.
    pub idle_holds: IdleHolds,
    /// The pages listening for the lock's refusals, shared by every
    /// connection's `System`. See [`crate::lock`].
    pub unlock_refusals: UnlockRefusals,
    /// The pages listening for clients' window requests, shared by every
    /// connection's `System`. The writer thread sends to them; see
    /// [`Outbound::WindowRequest`].
    pub window_requests: WindowRequests,
    /// The pages listening for bells, shared by every connection's `System`.
    /// The writer thread sends to them; see [`Outbound::Bell`].
    pub bells: Bells,
    /// The virtual monitors pages add. See [`crate::virtual_monitors`].
    pub virtual_monitors: VirtualMonitors,
    /// The keymaps and the one the desktop types on, shared by every
    /// connection's `System`. The Wayland thread lists them; see
    /// [`crate::DomicileCompositor::switch_the_keymap`].
    pub keymaps: Keymaps,
    /// The connections `domicile subscribe` holds. The writer thread tells
    /// them; see [`serve_outbound`].
    pub watchers: Watchers,
    /// The last input, or when the hub was made if there has been none. The
    /// Wayland thread sets it with [`ChromeHub::stirred`]; see
    /// [`ChromeHub::idle_time`].
    stirred_at: Mutex<Instant>,
}

impl ChromeHub {
    pub fn new(
        request_tx: Sender<ClientRequest>,
        max_scale: u32,
        wayland_display: OsString,
        child_nice: i32,
        portals: Portals,
    ) -> (Arc<Self>, OutboundReceiver) {
        let (outbound, outbound_rx) = outbound();
        let idle_watches = IdleWatches::new({
            let request_tx = Mutex::new(request_tx.clone());
            move || {
                let _ = request_tx.lock().unwrap().send(ClientRequest::IdleWatched);
            }
        });
        let hub = Arc::new(ChromeHub {
            host: Mutex::new(Host::new()),
            chromes: Mutex::new(Vec::new()),
            request_tx: Mutex::new(request_tx),
            outbound,
            timings: Mutex::new(FrameTimings::default()),
            max_scale: AtomicU32::new(max_scale),
            wayland_display,
            child_nice,
            offered: Mutex::new(None),
            lock: OnceLock::new(),
            log_filter: OnceLock::new(),
            portals,
            tray: OnceLock::new(),
            notifications: OnceLock::new(),
            eis: OnceLock::new(),
            shell_commands: ShellCommands::default(),
            idle_watches,
            idle_holds: IdleHolds::default(),
            unlock_refusals: UnlockRefusals::default(),
            window_requests: WindowRequests::default(),
            bells: Bells::default(),
            virtual_monitors: VirtualMonitors::default(),
            keymaps: Keymaps::default(),
            watchers: Watchers::default(),
            stirred_at: Mutex::new(Instant::now()),
        });
        (hub, outbound_rx)
    }

    /// Set the theme, tell every chrome, and start switching the windows.
    ///
    /// Both a config reload and [`ChromeMessage::SetTheme`] call this. Windows
    /// switch later, once every chrome has captured its starting frame; see
    /// `domicile_host::theme_turnover`.
    ///
    /// Does nothing if the theme is unchanged, so rewriting the config does not
    /// replay the theme transition. See `Host::set_theme`.
    pub fn take_up_the_theme(&self, theme: Theme) {
        // The theme, then the new theme's appearance if it has its own.
        let told = self.host.lock().unwrap().set_theme(theme);
        if !told.is_empty() {
            for message in told {
                self.broadcast(message);
            }
            // Read after the broadcast. A chrome that joins in between is then
            // waited on for a theme it already got in its handshake, which at
            // worst costs a deadline.
            let chromes = self
                .chromes
                .lock()
                .unwrap()
                .iter()
                .map(|chrome| chrome_key(&chrome.writer))
                .collect();
            self.send_request(ClientRequest::TurnTheWindows { theme, chromes });
        }
    }

    /// Whether the desktop is locked, for chrome connection threads.
    ///
    /// Unlocked until startup hands the hub the lock.
    pub fn the_desk_is_locked(&self) -> bool {
        self.lock.get().is_some_and(Seen::locked)
    }

    /// Forward an input event to the Wayland thread.
    pub fn send_request(&self, event: ClientRequest) {
        let _ = self.request_tx.lock().unwrap().send(event);
    }

    /// Whether the compositor may sync frames: some chrome is connected, and
    /// every one renders `<app frame>`. See
    /// `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
    ///
    /// Every one, because a move is broadcast. A page that sets `frame` some
    /// other way, such as always 0, would show a synced window's old frame.
    pub fn syncs_frames(&self) -> bool {
        let chromes = self.chromes.lock().unwrap();
        !chromes.is_empty() && chromes.iter().all(|chrome| chrome.syncs_frames)
    }

    /// Record whether the chrome on `writer` renders `<app frame>`.
    pub fn chrome_syncs_frames(&self, writer: &Arc<Mutex<UnixStream>>, syncs: bool) {
        for chrome in self.chromes.lock().unwrap().iter_mut() {
            if Arc::ptr_eq(&chrome.writer, writer) {
                chrome.syncs_frames = syncs;
            }
        }
    }

    /// How the desktop is, answering `which_status`.
    pub fn status(&self) -> HostMessage {
        self.host.lock().unwrap().status(
            self.the_desk_is_locked(),
            self.keymaps.listed().map(|listed| listed.active),
            self.idle_holds.holders(),
        )
    }

    /// Records input at `now`, for [`ChromeHub::idle_time`].
    pub fn stirred(&self, now: Instant) {
        *self.stirred_at.lock().unwrap() = now;
    }

    /// How long nobody has used the desktop as of `now`, answering
    /// `which_idle_time`.
    pub fn idle_time(&self, now: Instant) -> HostMessage {
        HostMessage::IdleTime {
            seconds: now
                .duration_since(*self.stirred_at.lock().unwrap())
                .as_secs(),
        }
    }

    /// The answer to a [`WatchTopic`], as its `which_*` gets it.
    pub fn watched(&self, topic: WatchTopic) -> HostMessage {
        match topic {
            WatchTopic::Windows => self.host.lock().unwrap().list_windows(),
            WatchTopic::Displays => self.host.lock().unwrap().list_displays(),
            WatchTopic::Inputs => self.host.lock().unwrap().list_inputs(),
            WatchTopic::Status => self.status(),
        }
    }

    /// Queue a host message for every connected chrome.
    pub fn broadcast(&self, message: HostMessage) {
        self.outbound.message(message);
    }
}

/// Apply a focus change made by the compositor and tell every chrome.
///
/// Broadcast because [`Host::focus_change`] reports each change once, and a
/// chrome that misses it shows the wrong window as active.
pub fn broadcast_focus_decision(hub: &ChromeHub, decision: ChromeMessage) {
    let moved = {
        let mut host = hub.host.lock().unwrap();
        let mut ready = true;
        let _ = apply_chrome_message(&mut host, &mut ready, decision);
        host.focus_change()
    };
    for message in moved {
        hub.broadcast(message);
    }
}

/// Tell every chrome that a client asked for keyboard focus, without granting
/// it.
///
/// A shell grants it by sending `focus_app` back. A shell can refuse, so
/// windows cannot steal focus from what the user is typing in. Broadcast
/// because the compositor does not know which chrome shows the desktop.
pub fn broadcast_focus_request(hub: &ChromeHub, app_id: &str) {
    let asked = hub.host.lock().unwrap().focus_requested(app_id);
    if let Some(message) = asked {
        hub.broadcast(message);
    }
}

/// Forget a closed client and tell every chrome.
///
/// Sends the close first, then any focus change it caused. The fallback hands
/// focus to the chrome, so a shell that wants to focus another window can
/// answer after it and have the last word.
pub fn broadcast_closed(hub: &ChromeHub, app_id: &str) {
    let (closed, focus) = {
        let mut host = hub.host.lock().unwrap();
        let closed = host.app_closed(app_id);
        // After the close, because closing the focused window moves focus.
        (closed, host.focus_change())
    };
    for message in closed.into_iter().chain(focus) {
        hub.broadcast(message);
    }
}

/// Tell every chrome which apps are already open.
///
/// `app_appeared` is sent once, so a page that loads or reloads after a client
/// maps would never learn of it. Broadcast because shells ignore apps they
/// already know.
///
/// Releases the `host` lock before broadcasting, so a slow chrome cannot block
/// the Wayland thread.
pub fn announce_open_apps(hub: &ChromeHub) {
    let announcements = hub.host.lock().unwrap().open_apps();
    for announcement in announcements {
        hub.broadcast(announcement);
    }
}

/// Write everything bound for the chromes, off the Wayland thread.
///
/// The only place that blocks on a chrome socket, so a slow chrome cannot stall
/// `commit()` and every client with it.
pub fn serve_outbound(hub: Arc<ChromeHub>, outbound: OutboundReceiver) {
    let mut window = FrameWindow::default();
    // Wake on a timeout too: compositing sends nothing outbound, so the report
    // would otherwise never run.
    while let Some(next) = outbound.recv_until(REPORT_EVERY) {
        // Asked after everything the writer handles, since nothing says when
        // a watched list changed, and on the timeout too, for what changes
        // with no message at all, like what holds the screens on.
        let Some(item) = next else {
            report(&mut window, &hub);
            hub.watchers.tell(|topic| hub.watched(topic));
            continue;
        };
        let message = match item {
            Outbound::Message(message) => message,
            Outbound::WindowRequest(app_id, request) => {
                hub.window_requests.send(&(app_id, request));
                continue;
            }
            Outbound::Bell(app_id) => {
                hub.bells.send(&app_id);
                continue;
            }
            Outbound::Watched => {
                hub.watchers.tell(|topic| hub.watched(topic));
                continue;
            }
        };
        crate::protocol_trace::trace("every shell", &message);
        // Encoded once; every chrome gets the same line.
        let line = to_line(&message);
        let mut chromes = hub.chromes.lock().unwrap();
        chromes.retain(|chrome| {
            let mut stream = chrome.writer.lock().unwrap();
            stream
                .write_all(line.as_bytes())
                .and_then(|_| stream.flush())
                .is_ok()
        });
        drop(chromes);
        hub.watchers.tell(|topic| hub.watched(topic));

        report(&mut window, &hub);
    }
}

/// Hubs and queues for tests of what the hub broadcasts.
#[cfg(test)]
pub mod fixture {
    use std::ffi::OsString;
    use std::sync::Arc;
    use std::time::Duration;

    use domicile_protocol::HostMessage;
    use smithay::reexports::calloop::channel::channel;

    use super::ChromeHub;
    use crate::client_requests::ClientRequest;
    use crate::outbound::Outbound;
    use crate::portals::Portals;

    /// Drain the hub's queued messages, in order.
    ///
    /// Reads until a read times out. Callers that know the expected count
    /// should assert the length.
    pub fn queued(outbound: &crate::outbound::OutboundReceiver) -> Vec<HostMessage> {
        let mut seen = Vec::new();
        while let Some(Some(item)) = outbound.recv_until(Duration::from_millis(100)) {
            let Outbound::Message(message) = item else {
                panic!("these tests queue no window requests");
            };
            seen.push(message);
        }
        seen
    }

    /// A hub with one app, ready to be focused.
    pub fn hub_with_an_app() -> (Arc<ChromeHub>, crate::outbound::OutboundReceiver, String) {
        let (request_tx, _requests) = channel::<ClientRequest>();
        let (hub, outbound) = ChromeHub::new(
            request_tx,
            1,
            OsString::from("wayland-1"),
            0,
            Portals::to_nobody(),
        );
        let app_id = drawn(&mut hub.host.lock().unwrap());
        (hub, outbound, app_id)
    }

    /// A window that has drawn its first frame, announced to the chromes.
    pub fn drawn(host: &mut domicile_host::Host) -> String {
        let app_id = host.app_created(
            domicile_protocol::Owner {
                pid: 1,
                uid: 1000,
                gid: 1000,
                pidfd_inode: None,
                sandbox: None,
            },
            "Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa".to_string(),
        );
        host.app_mapped(
            &app_id,
            domicile_host::Mapped {
                size: (100.0, 100.0),
                has_parent: false,
                client_frame: false,
            },
        );
        app_id
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::time::Duration;

    use domicile_protocol::{ChromeMessage, HostMessage, Theme};
    use smithay::reexports::calloop::channel::channel;

    use super::fixture::{drawn, hub_with_an_app, queued};
    use super::{
        announce_open_apps, broadcast_closed, broadcast_focus_decision, broadcast_focus_request,
        ChromeHub,
    };
    use crate::client_requests::ClientRequest;
    use crate::outbound::Outbound;
    use crate::portals::Portals;

    #[test]
    fn a_theme_the_shell_picked_reaches_every_page_on_the_desk() {
        // A click on one monitor's page must switch every page. The compositor
        // broadcasts the answer to all chromes, including the sender.
        let (request_tx, _requests) = channel::<ClientRequest>();
        let (hub, outbound) = ChromeHub::new(
            request_tx,
            1,
            OsString::from("wayland-1"),
            0,
            Portals::to_nobody(),
        );

        hub.take_up_the_theme(Theme::Light);

        assert!(
            matches!(
                outbound.recv_until(Duration::from_millis(100)),
                Some(Some(Outbound::Message(HostMessage::Theme {
                    theme: Theme::Light
                })))
            ),
            "the theme is broadcast"
        );
        assert_eq!(
            hub.host.lock().unwrap().describe_theme(),
            HostMessage::Theme {
                theme: Theme::Light
            },
            "and remembered, so the chrome that connects next is told it too"
        );
    }

    #[test]
    fn a_theme_that_is_already_the_desks_is_not_restated() {
        // Reloads re-apply the theme often. Broadcasting an unchanged theme
        // would replay the transition on every page.
        let (request_tx, _requests) = channel::<ClientRequest>();
        let (hub, outbound) = ChromeHub::new(
            request_tx,
            1,
            OsString::from("wayland-1"),
            0,
            Portals::to_nobody(),
        );

        hub.take_up_the_theme(Theme::Dark);

        assert!(
            matches!(outbound.recv_until(Duration::from_millis(100)), Some(None)),
            "a host that came up dark is already dark, so nothing is queued"
        );
    }

    #[test]
    fn a_page_that_says_hello_is_told_what_is_already_running() {
        // Nothing else re-sends `app_appeared`, so a reloaded page would see an
        // empty screen.
        let (request_tx, _requests) = channel::<ClientRequest>();
        let (hub, outbound) = ChromeHub::new(
            request_tx,
            1,
            OsString::from("wayland-1"),
            0,
            Portals::to_nobody(),
        );
        let first = drawn(&mut hub.host.lock().unwrap());
        let second = drawn(&mut hub.host.lock().unwrap());

        announce_open_apps(&hub);

        // Two windows plus a focus message, then one read that confirms nothing
        // followed.
        let mut announced = Vec::new();
        for _ in 0..4 {
            match outbound.recv_until(Duration::from_millis(100)) {
                Some(Some(Outbound::Message(HostMessage::AppAppeared { app_id, .. }))) => {
                    announced.push(app_id);
                }
                // Focus is sent with the windows; tested in `domicile-host`,
                // skipped here.
                Some(Some(Outbound::Message(HostMessage::FocusChanged { .. }))) => {}
                Some(Some(_)) => panic!("something other than an announcement was queued"),
                Some(None) => break,
                None => panic!("the queue's sending half went away"),
            }
        }

        assert_eq!(
            announced,
            vec![first, second],
            "both open windows, in the order they arrived"
        );
    }

    #[test]
    fn a_focus_the_compositor_decided_reaches_every_chrome() {
        // Focus decided by the compositor is invisible to the chrome otherwise,
        // and `focus_change` reports it once.
        let (hub, outbound, app_id) = hub_with_an_app();

        broadcast_focus_decision(
            &hub,
            ChromeMessage::FocusApp {
                app_id: app_id.clone(),
            },
        );

        assert_eq!(
            queued(&outbound),
            vec![HostMessage::FocusChanged {
                app_id: Some(app_id)
            }]
        );
    }

    #[test]
    fn a_click_on_the_desktop_says_the_keyboard_came_back() {
        // Focus returning to the chrome must be announced, or the window stays
        // marked active.
        let (hub, outbound, app_id) = hub_with_an_app();
        broadcast_focus_decision(&hub, ChromeMessage::FocusApp { app_id });
        let _ = queued(&outbound);

        broadcast_focus_decision(&hub, ChromeMessage::FocusChrome);

        assert_eq!(
            queued(&outbound),
            vec![HostMessage::FocusChanged { app_id: None }]
        );
    }

    #[test]
    fn a_client_asking_for_the_keyboard_reaches_every_chrome_and_moves_nothing() {
        // Granting `xdg-activation` here would take the policy from the shell.
        // It is broadcast as a question and focus does not move.
        let (hub, outbound, app_id) = hub_with_an_app();
        broadcast_focus_decision(&hub, ChromeMessage::FocusChrome);
        let _ = queued(&outbound);

        broadcast_focus_request(&hub, &app_id);

        assert_eq!(
            queued(&outbound),
            vec![HostMessage::FocusRequested {
                app_id: app_id.clone()
            }],
            "the request goes out, and no `focus_changed` with it"
        );
        assert_eq!(
            hub.host.lock().unwrap().focus_holder(),
            None,
            "the keyboard is where it was"
        );
    }

    #[test]
    fn a_request_from_a_window_this_compositor_never_announced_goes_nowhere() {
        // A shell has no element for it and could not answer.
        let (hub, outbound, _) = hub_with_an_app();

        broadcast_focus_request(&hub, "app-404");

        assert_eq!(queued(&outbound), vec![]);
    }

    #[test]
    fn a_focused_window_closing_says_both_things_in_order() {
        // Both the close and the focus return, in that order, or the chrome
        // marks a closed window active.
        let (hub, outbound, app_id) = hub_with_an_app();
        broadcast_focus_decision(
            &hub,
            ChromeMessage::FocusApp {
                app_id: app_id.clone(),
            },
        );
        let _ = queued(&outbound);

        broadcast_closed(&hub, &app_id);

        assert_eq!(
            queued(&outbound),
            vec![
                HostMessage::AppClosed {
                    app_id: app_id.clone()
                },
                HostMessage::FocusChanged { app_id: None },
            ]
        );
    }

    #[test]
    fn the_idle_time_counts_whole_seconds_since_the_last_input() {
        let (hub, _outbound, _) = hub_with_an_app();
        let input = std::time::Instant::now();

        hub.stirred(input);

        assert_eq!(
            hub.idle_time(input + Duration::from_millis(90_700)),
            HostMessage::IdleTime { seconds: 90 }
        );
        assert_eq!(hub.idle_time(input), HostMessage::IdleTime { seconds: 0 });
    }
}
