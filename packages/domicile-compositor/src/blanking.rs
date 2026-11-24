//! Blanks the screens when nobody is here, tells the shell's idle watches, and
//! honors the idle inhibitors that hold both off. The clock is
//! `crate::idle`'s.

use std::time::{Duration, Instant};

use smithay::delegate_idle_inhibit;
use smithay::reexports::{
    calloop::{
        timer::{TimeoutAction, Timer},
        InsertError,
    },
    wayland_server::{
        protocol::{wl_callback::WlCallback, wl_surface::WlSurface},
        Resource as _,
    },
};
use smithay::wayland::{
    compositor::with_states,
    idle_inhibit::IdleInhibitHandler,
    shell::xdg::{ToplevelSurface, XdgToplevelSurfaceData},
};
use tracing::{debug, info};

use domicile_host::system::DisplayPower;

use crate::client_requests::ClientRequest;
use crate::display_sleep::asleep_in;
use crate::held_frames::HeldFrames;
use crate::idle::{announced, darkened, somebody_is_here, Blanking, StillThere};
use crate::screen_saver::{self, Change, Hold, BROWSER};
use crate::screens::name_of;
use crate::{CalloopData, DomicileCompositor};

/// Routes `zwp_idle_inhibitor_v1` requests to the idle clock.
///
/// Smithay passes only the surface, so `Idle` stores surfaces. Dead clients'
/// inhibitors are released by
/// [`DomicileCompositor::let_go_of_what_the_dead_were_holding`]; inhibitors on
/// surfaces with no window are handled by
/// [`DomicileCompositor::the_windows_changed`].
impl IdleInhibitHandler for DomicileCompositor {
    fn inhibit(&mut self, surface: WlSurface) {
        self.hold_the_screens_on(surface);
    }

    fn uninhibit(&mut self, surface: WlSurface) {
        self.let_the_screens_go(&surface);
    }
}

delegate_idle_inhibit!(DomicileCompositor);

/// An inhibitor holds only while its surface is alive.
///
/// A dead client's objects stop being alive when its connection is cleaned up,
/// so its inhibitor stops holding without a destroy. See [`StillThere`].
impl StillThere for WlSurface {
    fn still_there(&self) -> bool {
        self.is_alive()
    }
}

impl DomicileCompositor {
    /// Record user activity, and wake the screens if they were dark.
    ///
    /// All input passes through the page and arrives here.
    /// [`crate::idle::somebody_is_here`] decides which requests count.
    pub fn keep_the_desktop_awake(&mut self, request: &ClientRequest) {
        let Some(input) = somebody_is_here(request) else {
            return;
        };
        if self.display_sleep.stirred(Instant::now()) {
            info!(input, "somebody is at this desktop again; its screens wake");
            self.state_the_connectors();
        }
        let idle = &mut self.idle;
        let now = Instant::now();
        // Logging each restart would flood the journal; one that held off a
        // close blank or lock shows what keeps a desk from going idle.
        let still = idle.still_for(now);
        if idle.worth_noting(still) {
            // The browser names its own input, and the device it came from.
            let detail = match request {
                ClientRequest::Activity { input } => input.as_deref(),
                _ => None,
            };
            debug!(
                input,
                detail,
                still_seconds = still.as_secs_f32(),
                "input restarts the idle clock"
            );
        }
        self.hub.stirred(now);
        match idle.stirred(now) {
            Some(Blanking::ComeBack) => {
                info!("somebody is at this desktop again; its screens come back on");
                self.tell_the_chromes_whether_anybody_is_here();
                self.state_the_connectors();
            }
            Some(Blanking::GoDark) => unreachable!("input never darkens a desktop"),
            None => {}
        }
        if self.hub.idle_watches.stirred() {
            self.settle_the_idle_watches();
        }
    }

    /// Handle the idle timer. Returns when to fire next; see
    /// [`Idle::next_check`].
    fn the_idle_clock_came_round(&mut self) -> Duration {
        // First, so the lock screen is up before a modeset lights a screen,
        // and so `next_check` knows the lock has fired.
        self.lock_if_nobody_is_here("nobody is at this desktop; it locks itself");
        let now = Instant::now();
        let on_the_desktop = self.surfaces_on_the_desktop();
        let edge = self.idle.elapsed(now, &on_the_desktop);
        let next = self.idle.next_check(now);
        if edge == Some(Blanking::GoDark) {
            info!(
                connectors = self.engine_displays.len(),
                "nobody is at this desktop; its screens go dark"
            );
            self.tell_the_chromes_whether_anybody_is_here();
            self.state_the_connectors();
        }
        next
    }

    /// Lock the desktop, logging `why`, if `idle.lock_after_seconds` has
    /// passed with nobody here. See [`Idle::lock_due`].
    fn lock_if_nobody_is_here(&mut self, why: &str) {
        let toplevels = &self.toplevels;
        let held_frames = &self.held_frames;
        if self
            .idle
            .lock_due(Instant::now(), || desktop_surfaces(toplevels, held_frames))
        {
            self.shut_the_desk(why);
        }
    }

    /// Arm the idle timer for [`Idle::next_check`], replacing any existing
    /// one.
    ///
    /// A desktop that never blanks or locks gets no timer. Removing the old
    /// one keeps reloads from piling up timers.
    pub fn arm_the_idle_clock(&mut self) -> Result<(), InsertError<Timer>> {
        if let Some(armed) = self.idle_clock.take() {
            self.loop_handle.remove(armed);
        }
        if self.idle.times_out() {
            self.idle_clock = Some(self.loop_handle.insert_source(
                Timer::from_duration(self.idle.next_check(Instant::now())),
                |_, _, data: &mut CalloopData| {
                    TimeoutAction::ToDuration(data.state.the_idle_clock_came_round())
                },
            )?);
        }
        Ok(())
    }

    /// Turn the monitor named `output`, or every monitor, off or on because
    /// somebody asked. See
    /// [`crate::display_sleep`].
    ///
    /// A wake also stirs the idle clock, through
    /// [`keep_the_desktop_awake`](DomicileCompositor::keep_the_desktop_awake),
    /// so it lights screens idle blanking turned off too.
    pub fn power_the_displays(&mut self, power: DisplayPower, output: Option<&str>) {
        let changed = match (power, output) {
            (DisplayPower::Asleep, None) => self.display_sleep.sleep(Instant::now()),
            (DisplayPower::Awake, None) => self.display_sleep.wake(),
            (DisplayPower::Asleep, Some(name)) => self.display_sleep.sleep_one(name),
            (DisplayPower::Awake, Some(name)) => self.display_sleep.wake_one(name),
        };
        if changed {
            debug!(
                ?power,
                ?output,
                "somebody asked to turn this desktop's screens"
            );
            self.state_the_connectors();
        }
    }

    /// Tell the engine which connectors to light.
    ///
    /// Awake: [`Screens::scanout`] (a profile's connectors, or empty for no
    /// opinion), less the monitors slept by name
    /// ([`crate::display_sleep::asleep_in`]). Dark, from idle blanking or
    /// [`crate::display_sleep`]: every reported connector, turned off. An
    /// empty list would light everything, so an empty
    /// [`crate::idle::darkened`] is not sent.
    pub fn state_the_connectors(&self) {
        // Every blanking edge passes here.
        self.tell_the_portal_about_the_screensaver();
        self.hub.host.lock().unwrap().describe_darkness(
            self.the_screens_are_dark() || self.display_sleep.asleep(),
            self.display_sleep.sleeping().to_vec(),
        );
        let Some(session) = self.engine.as_ref() else {
            return;
        };
        if self.the_screens_are_dark() || self.display_sleep.asleep() {
            let dark = darkened(&self.engine_displays, self.screens.scanout());
            if !dark.is_empty() {
                session.configure_displays(&dark);
            }
        } else if self.display_sleep.sleeping().is_empty() {
            session.configure_displays(self.screens.scanout());
        } else {
            let names = self.display_sleep.sleeping();
            let asleep: Vec<i64> = self
                .engine_displays
                .iter()
                .filter(|display| names.contains(&name_of(display)))
                .map(|display| display.id)
                .collect();
            session.configure_displays(&asleep_in(
                &self.engine_displays,
                self.screens.scanout(),
                &asleep,
            ));
        }
    }

    /// Whether this desktop's screens are off because nobody is here.
    pub fn the_screens_are_dark(&self) -> bool {
        self.idle.dark()
    }

    /// Keep a blanked or sleeping desktop dark after a hotplug.
    ///
    /// A hotplugged monitor arrives lit, and on a described desktop (or an
    /// unappliable profile) nothing else sets the connectors. Only acts when
    /// dark, to avoid a needless modeset.
    pub fn keep_the_screens_dark(&self) {
        if self.the_screens_are_dark()
            || self.display_sleep.asleep()
            || !self.display_sleep.sleeping().is_empty()
        {
            self.state_the_connectors();
        }
    }

    /// Tell every chrome whether the desktop is idle.
    ///
    /// Call before setting the connectors. Relighting takes tens of
    /// milliseconds and a page repaints in one, so the shell can hide sensitive
    /// content before the screen is visible. See [`HostMessage::Idle`].
    ///
    /// Unguarded, unlike
    /// [`tell_a_new_chrome_whether_anybody_is_here`](DomicileCompositor::tell_a_new_chrome_whether_anybody_is_here):
    /// every caller is a state change, including a reload that removes the
    /// timeout while the screens are dark.
    pub fn tell_the_chromes_whether_anybody_is_here(&self) {
        self.hub.broadcast(announced(self.the_screens_are_dark()));
    }

    /// Tell the shell's idle watches how long the desk has been still, and
    /// arm a timer for the next one due. See `domicile_host::idle_watches`,
    /// which tells a page only of a change.
    ///
    /// Called when a page watches, when an inhibitor changes, when the clock
    /// restarts and when input ends an idle spell. Other input only moves the
    /// next watch later, so a timer armed before it fires early and arms the
    /// rest.
    pub fn settle_the_idle_watches(&mut self) {
        let still = self
            .idle
            .unheld_for(Instant::now(), &self.surfaces_on_the_desktop());
        let due = self.hub.idle_watches.settle(still, self.idle.blank_after());
        if let Some(armed) = self.idle_watch_clock.take() {
            self.loop_handle.remove(armed);
        }
        let Some(due) = due else {
            return;
        };
        self.idle_watch_clock = Some(
            self.loop_handle
                .insert_source(Timer::from_duration(due), |_, _, data: &mut CalloopData| {
                    // Spent, so not removed again.
                    data.state.idle_watch_clock = None;
                    data.state.settle_the_idle_watches();
                    TimeoutAction::Drop
                })
                .expect("the event loop takes a timer"),
        );
    }

    /// Tell a new chrome whether the desktop is idle.
    ///
    /// Silent if the desktop never blanks, so the shell does not show idle UI
    /// that can never trigger. A blanking desktop sends `false` even when
    /// active.
    pub fn tell_a_new_chrome_whether_anybody_is_here(&self) {
        if self.idle.blanks() {
            self.tell_the_chromes_whether_anybody_is_here();
        }
    }

    /// A client took an idle inhibitor for `surface`.
    fn hold_the_screens_on(&mut self, surface: WlSurface) {
        let on_the_desktop = self.surfaces_on_the_desktop();
        let edge = self
            .idle
            .inhibited_by(surface, Instant::now(), &on_the_desktop);
        self.the_inhibitors_changed(edge, "a client is holding this desktop awake");
        self.tell_the_shells_what_holds_the_desktop_awake();
    }

    /// The applications holding idle inhibitors through the portal, one name
    /// per inhibitor.
    pub fn held_awake_by_the_portal(&mut self, by: Vec<String>) {
        self.held_by_portal_apps = by;
        self.the_applications_holds_changed("an application's portal inhibitor changed");
    }

    /// What applications asked `org.freedesktop.ScreenSaver` to hold.
    pub fn held_awake_by_the_screen_saver(&mut self, by: Vec<Hold>, change: Change) {
        self.held_by_screen_saver = by;
        self.the_applications_holds_changed(match change {
            Change::Asked => "an application asked to keep the screens on",
            Change::Gone => "an application that kept the screens on is gone",
        });
    }

    /// Re-evaluate the holds of applications rather than windows, logging
    /// `why` if the screens change.
    fn the_applications_holds_changed(&mut self, why: &str) {
        let held = !self.applications_holding().is_empty();
        let on_the_desktop = self.surfaces_on_the_desktop();
        let edge = self
            .idle
            .held_by_applications(held, Instant::now(), &on_the_desktop);
        self.the_inhibitors_changed(edge, why);
        self.tell_the_shells_what_holds_the_desktop_awake();
    }

    /// The applications holding the desktop awake through the portal or the
    /// screen saver, one name per hold. A screen saver hold from a process
    /// with windows counts only while one is shown; see
    /// [`screen_saver::still_holds`]. One from the engine's browser process is
    /// [`BROWSER`].
    fn applications_holding(&self) -> Vec<String> {
        let windows: Vec<(Option<u32>, bool)> = if self.held_by_screen_saver.is_empty() {
            Vec::new()
        } else {
            self.toplevels
                .iter()
                .map(|(id, toplevel)| {
                    let pid = toplevel
                        .wl_surface()
                        .client()
                        .and_then(|client| client.get_credentials(&self.display_handle).ok())
                        .and_then(|credentials| u32::try_from(credentials.pid).ok());
                    (pid, !self.held_frames.is_hidden(id))
                })
                .collect()
        };
        let engine = self.engine_process.and_then(|pid| u32::try_from(pid).ok());
        self.held_by_portal_apps
            .iter()
            .cloned()
            .chain(
                self.held_by_screen_saver
                    .iter()
                    .filter(|hold| screen_saver::still_holds(hold.pid, &windows))
                    .map(|hold| {
                        if hold.pid.is_some() && hold.pid == engine {
                            BROWSER.to_string()
                        } else {
                            hold.app.clone()
                        }
                    }),
            )
            .collect()
    }

    /// A client released an idle inhibitor.
    fn let_the_screens_go(&mut self, surface: &WlSurface) {
        let on_the_desktop = self.surfaces_on_the_desktop();
        let edge = self
            .idle
            .uninhibited_by(surface, Instant::now(), &on_the_desktop);
        self.the_inhibitors_changed(edge, "nothing is holding this desktop awake now");
        self.tell_the_shells_what_holds_the_desktop_awake();
    }

    /// Release inhibitors held by dead clients.
    ///
    /// A crashed client sends no destroy, so this runs after every client
    /// dispatch. Otherwise its inhibitor would keep the desktop awake forever.
    /// Smithay only exposes the inhibitor's surface on the request, so there is
    /// no `destroyed` hook to use. Cheap: it checks a handful of inhibitors and
    /// acts only on a change.
    ///
    /// Usually [`the_windows_changed`](DomicileCompositor::the_windows_changed)
    /// has already handled the dead client's window. This still releases
    /// inhibitors on surfaces that were never windows.
    pub fn let_go_of_what_the_dead_were_holding(&mut self) {
        let toplevels = &self.toplevels;
        let held = self.idle.inhibitors();
        let held_frames = &self.held_frames;
        let edge = self
            .idle
            .the_dead_let_go(Instant::now(), || desktop_surfaces(toplevels, held_frames));
        let let_go = self.idle.inhibitors() != held;
        // Listing the holders and settling the watches after every dispatch
        // would cost a window list each time, so only when one went.
        if let_go {
            self.the_inhibitors_changed(edge, "the client holding this desktop awake is gone");
            self.tell_the_shells_what_holds_the_desktop_awake();
        } else {
            self.lock_if_nobody_is_here("nothing holds this desktop awake now; it locks itself");
        }
    }

    /// Re-evaluate inhibitors after the windows changed.
    ///
    /// An inhibitor holds only while its surface is a window on the desktop,
    /// and clients send no inhibitor request when a window maps or closes. A
    /// screen saver hold from a window's process changes with it too.
    pub fn the_windows_changed(&mut self, why: &str) {
        self.the_applications_holds_changed(why);
    }

    /// Tell the shells what holds the desktop awake, and log it when that
    /// changes. See `domicile_host::idle_holds`.
    ///
    /// Each holder is its application's id, for the shell to name and draw
    /// by its desktop entry: a Wayland inhibitor's window's app id, the
    /// portal's and screen saver's application holding each. A shell page's
    /// own portal hold is `domicile`, and a browser window's page's
    /// [`BROWSER`].
    pub fn tell_the_shells_what_holds_the_desktop_awake(&mut self) {
        let on_the_desktop = self.surfaces_on_the_desktop();
        let holders: Vec<String> = self
            .idle
            .holding(&on_the_desktop)
            .map(|surface| window_name(&self.toplevels, surface))
            .chain(self.applications_holding())
            .collect();
        if self.hub.idle_holds.hold(holders.clone()) {
            debug!(?holders, "what holds this desktop awake changed");
        }
    }

    /// Act on an inhibitor state change, logging `why`.
    ///
    /// Settles the shell's idle watches, which the inhibitors hold too. Sets
    /// the connectors only when the screens go dark or come back.
    ///
    /// Also locks a desktop whose lock timeout passed while an inhibitor held
    /// it.
    fn the_inhibitors_changed(&mut self, edge: Option<Blanking>, why: &str) {
        self.lock_if_nobody_is_here("nothing holds this desktop awake now; it locks itself");
        self.settle_the_idle_watches();
        let Some(edge) = edge else {
            return;
        };
        match edge {
            Blanking::GoDark => {
                info!("{why}; this desktop's screens go dark");
                self.state_the_connectors();
            }
            Blanking::ComeBack => {
                info!("{why}; this desktop's screens come back on");
                self.state_the_connectors();
            }
        }
    }

    /// Every toplevel surface the page shows. See [`desktop_surfaces`].
    pub fn surfaces_on_the_desktop(&self) -> Vec<WlSurface> {
        desktop_surfaces(&self.toplevels, &self.held_frames)
    }
}

/// The app id of the window on `surface`, or its id in this compositor for a
/// client that set none.
fn window_name(toplevels: &[(String, ToplevelSurface)], surface: &WlSurface) -> String {
    let (id, toplevel) = toplevels
        .iter()
        .find(|(_, toplevel)| toplevel.wl_surface() == surface)
        .expect("an inhibitor holds only on a window");
    with_states(toplevel.wl_surface(), |states| {
        states
            .data_map
            .get::<XdgToplevelSurfaceData>()
            .and_then(|data| data.lock().unwrap().app_id.clone())
    })
    .unwrap_or_else(|| id.clone())
}

/// Every surface of `toplevels` the page shows.
///
/// The idle clock needs it because an inhibitor on any other surface holds
/// nothing. A window the page hides, on another workspace or behind a tab, is
/// left out: the protocol lets an inhibitor go once its surface is not visible,
/// and an app in the background, like a chat app animating, would otherwise
/// keep the screens on unseen. Cloned (a refcount) because the clock is
/// borrowed mutably alongside.
fn desktop_surfaces(
    toplevels: &[(String, ToplevelSurface)],
    held_frames: &HeldFrames<WlCallback>,
) -> Vec<WlSurface> {
    toplevels
        .iter()
        .filter(|(id, _)| !held_frames.is_hidden(id))
        .map(|(_, toplevel)| toplevel.wl_surface().clone())
        .collect()
}
