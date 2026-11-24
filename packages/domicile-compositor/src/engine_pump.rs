//! Running the engine's events on the Wayland thread, returning the buffers it
//! lets go of, and rejoining an engine that replaced it.

use std::collections::BTreeMap;
use std::time::Instant;

use domicile_protocol::HostMessage;
use smithay::reexports::calloop::{
    generic::Generic,
    timer::{TimeoutAction, Timer},
    Interest, LoopHandle, Mode, PostAction, RegistrationToken,
};
use smithay::wayland::{
    selection::data_device::set_data_device_selection,
    selection::primary_selection::set_primary_selection,
};
use tracing::{debug, error, warn};

use crate::compositor_casts::capturer;
use crate::configure_answers::{ConfigureAnswers, Resize, Resized};
use crate::dmabuf_descriptor::descriptor_from;
use crate::engine::Clipboard;
use crate::engine_buffers::Returned;
use crate::engine_session::{Dispatched, EngineSession, Release, Submitted};
use crate::frame_descriptor::FrameDescriptor;
use crate::frame_publishing::Upload;
use crate::selections::Holder;
use crate::surface_commit::{committed_buffer, CommittedBuffer};
use crate::which_engine::another_engine;
use crate::{engine, thread_priority};
use crate::{CalloopData, DomicileCompositor};

impl DomicileCompositor {
    /// Lay the desk out again from the engine's last display report and the
    /// virtual monitors' scales. `replugged_into` decides whether the engine
    /// defines the desktop. `adopt_the_desktop` does nothing for an unchanged
    /// list, which a modeset-triggered hotplug reports.
    pub fn lay_out_the_engines_displays(&mut self) {
        let laid_out = self.output_settings().and_then(|output| {
            self.screens.replugged_into(
                &self.engine_displays,
                &output,
                &self.vendors,
                &self.virtual_displays,
            )
        });
        match laid_out {
            // The desktop stays: the config describes it, or the engine is
            // mid-update. A monitor that arrives while the screens are dark
            // comes up lit, so darken it again.
            Ok(None) => self.keep_the_screens_dark(),
            // `adopt_the_desktop` sets every connector's power, dark ones
            // included.
            Ok(Some(screens)) => {
                let dh = self.display_handle.clone();
                self.adopt_the_desktop(&dh, screens);
            }
            // A matching profile cannot be applied. Keep the current desktop,
            // as `ConfigStore` does for an unparseable edit, and name the
            // config problem.
            Err(err) => {
                tracing::error!(
                    %err,
                    "the profile these monitors matched cannot be applied to them; \
                     keeping the desktop that is up"
                );
                // Keep it dark too; the unplaced monitor came up lit.
                self.keep_the_screens_dark();
            }
        }
    }

    /// Run the engine's pending work and act on its events.
    ///
    /// Called only from the engine's calloop source, because the ABI's
    /// callbacks fire inside `dispatch`.
    fn pump_the_engine(&mut self) {
        let Some(session) = self.engine.as_mut() else {
            return;
        };
        let Dispatched {
            events,
            releases,
            shown,
        } = session.dispatch(Instant::now());
        let overdue = session.overdue(Instant::now());
        self.take_back(releases.into_iter().chain(overdue));
        for (app_id, frame) in shown {
            tracing::trace!(%app_id, frame, "the engine took a frame");
            self.frame_shown(&app_id);
            self.frame_callbacks.submitted(&app_id, frame);
        }

        for event in events {
            match event {
                // The page's layout box changed. Send `xdg_toplevel.configure`
                // with the new size.
                engine::Event::Configure {
                    surface,
                    width,
                    height,
                    scale,
                    number,
                    zoom,
                } => {
                    let app_id = self
                        .engine
                        .as_ref()
                        .and_then(|session| session.app_for(surface))
                        .map(str::to_owned);
                    let Some(app_id) = app_id else {
                        tracing::debug!(
                            ?surface,
                            width,
                            height,
                            "the engine configured a surface no window has"
                        );
                        continue;
                    };
                    tracing::trace!(
                        %app_id,
                        ?surface,
                        width,
                        height,
                        ?scale,
                        ?number,
                        zoom,
                        "the engine laid out a window"
                    );
                    // Now embedded, so a frame committed earlier can be shown.
                    // Often a popup's only frame.
                    let waited = self
                        .engine
                        .as_mut()
                        .map(|session| session.show_what_was_waiting(surface, Instant::now()));
                    match waited {
                        Some(Ok(Some(frame))) => {
                            self.frame_shown(&app_id);
                            self.frame_callbacks.submitted(&app_id, frame);
                        }
                        Some(Err(refused)) => {
                            error!(%app_id, "the engine would not take the frame that waited for this window");
                            self.returned(refused.buffer);
                        }
                        Some(Ok(None)) | None => {}
                    }
                    // A popup's size comes from its positioner, not the page,
                    // and a subsurface's from its own buffer.
                    if self.popups.iter().any(|(id, _)| *id == app_id)
                        || self.subsurfaces.iter().any(|sub| sub.app_id == app_id)
                    {
                        continue;
                    }
                    let Some(toplevel) = self.toplevel_for(&app_id) else {
                        tracing::debug!(%app_id, "the engine configured an app with no toplevel");
                        continue;
                    };
                    // The engine sends device pixels; a configure is logical.
                    // Unconverted, a window on a 1.2x display draws 1.2x too
                    // small.
                    //
                    // Use the scale the engine sends with the box. The reported
                    // ratio is a fallback for older engines.
                    //
                    // A zoomed `<app>` is configured `zoom` times smaller and
                    // told to draw `zoom` times denser, so it fills the box
                    // sharp rather than resampled.
                    if self.app_zoom.get(&app_id).copied().unwrap_or(1.0) != zoom {
                        self.zoom_window(&app_id, &toplevel, zoom);
                    }
                    let device_size = (width, height);
                    let (width, height) = crate::scale::logical_box(
                        device_size,
                        crate::scale::zoomed(scale.unwrap_or(self.device_pixel_ratio), zoom),
                    );
                    tracing::debug!(%app_id, width, height, ?number, "engine configure -> client");
                    match number {
                        Some(number) => {
                            let resize = Resize {
                                number,
                                device_size,
                                size: (width, height),
                            };
                            let resized = self
                                .configure_answers
                                .entry(app_id.clone())
                                .or_insert_with(ConfigureAnswers::new)
                                .resize(resize, Instant::now());
                            match resized {
                                Resized::Send(resize) => {
                                    self.send_resize(&app_id, &toplevel, resize)
                                }
                                Resized::Waits(until) => self.resize_when_overdue(app_id, until),
                                Resized::Coalesced => {}
                            }
                        }
                        // Sends only if the size differs from the last
                        // acknowledged configure.
                        None => {
                            toplevel.with_pending_state(|state| {
                                state.size = Some((width as i32, height as i32).into());
                            });
                            toplevel.send_pending_configure();
                        }
                    }
                }
                // Handled by the session, with the buffers.
                engine::Event::Released { .. } | engine::Event::Imported { .. } => {}
                engine::Event::FrameDone { surface, frame } => {
                    let app_id = self
                        .engine
                        .as_ref()
                        .and_then(|session| session.app_for(surface))
                        .map(str::to_owned);
                    if let Some(app_id) = app_id {
                        let callbacks = self.frame_callbacks.done(&app_id, frame);
                        tracing::trace!(
                            %app_id,
                            frame,
                            callbacks = callbacks.len(),
                            "the engine drew a frame; its callbacks go"
                        );
                        self.send_frames(callbacks);
                    }
                }
                engine::Event::Presented {
                    surface,
                    frame,
                    shown,
                } => {
                    let app_id = self
                        .engine
                        .as_ref()
                        .and_then(|session| session.app_for(surface))
                        .map(str::to_owned);
                    tracing::trace!(
                        app_id = app_id.as_deref().unwrap_or("none"),
                        ?surface,
                        frame,
                        shown = shown.is_some(),
                        "the engine presented a frame"
                    );
                    if let Some(app_id) = &app_id {
                        if self.presentations.presented(app_id, frame, shown.is_some()) {
                            self.hub.broadcast(HostMessage::AppPresented {
                                app_id: app_id.clone(),
                            });
                        }
                    }
                    let presented = app_id.as_deref().and_then(|app_id| {
                        self.frame_callbacks
                            .presented(app_id, frame)
                            .map(|presented| (app_id, presented))
                    });
                    if let (Some(app_id), Some(shown)) = (&app_id, shown) {
                        let took = presented
                            .as_ref()
                            .map(|(_, presented)| shown.time.saturating_sub(presented.committed));
                        self.latency_presented(app_id, shown.refresh, took);
                    }
                    if let Some((app_id, presented)) = presented {
                        self.present(app_id, presented, shown);
                    }
                }
                engine::Event::Captured {
                    capture,
                    frame,
                    captured,
                } => {
                    tracing::trace!(target: "domicile::engine::cast", ?capture, frame, "the engine captured a frame for a cast");
                    self.cast_captured(capture, frame, captured)
                }
                engine::Event::Compositing { in_memory } => self.engine_composites(in_memory),
                engine::Event::BrowserWindows(windows) => {
                    tracing::debug!(
                        target: "domicile::engine::windows",
                        windows = ?windows
                            .iter()
                            .map(|window| (&window.id, &window.app_id, window.views.len()))
                            .collect::<Vec<_>>(),
                        "the engine's browser windows (id, app id, views)"
                    );
                    self.hub.host.lock().unwrap().browser_windows(
                        windows
                            .iter()
                            .map(|window| domicile_host::BrowserWindow {
                                id: window.id.clone(),
                                title: window.title.clone(),
                                app_id: window.app_id.clone(),
                                url: window.url.clone(),
                                private: window.private,
                                views: window
                                    .views
                                    .iter()
                                    .map(|view| domicile_protocol::ListedView {
                                        id: view.id.clone(),
                                        position: [view.x, view.y],
                                        size: [view.width, view.height],
                                    })
                                    .collect(),
                            })
                            .collect(),
                    );
                    let capturer = capturer(&mut self.engine, &mut self.cast_test_pattern);
                    self.casting.browser_windows(&windows, capturer);
                    let listed = self.foreign_toplevels.browser_windows(&windows);
                    self.browser_toplevels_listed(listed);
                }
                engine::Event::InputDevices(inputs) => {
                    tracing::debug!(target: "domicile::engine::input", devices = inputs.len(), "the engine's input devices changed");
                    self.hub.host.lock().unwrap().input_devices(inputs);
                    // Not told to the chromes, so the watchers would not hear.
                    self.hub.outbound.watched();
                }
                engine::Event::GammaSizes(sizes) => self.gamma_sizes_reported(sizes),
                // Acted on at the next hello, which is the new engine's.
                engine::Event::Disconnected => {
                    error!("the engine this desktop was drawing through went away");
                    self.engine_disconnected = true;
                    // Its windows went with it.
                    self.hub.host.lock().unwrap().browser_windows(Vec::new());
                    self.casting.browser_windows(&[], None);
                    let listed = self.foreign_toplevels.browser_windows(&[]);
                    self.browser_toplevels_listed(listed);
                }
                engine::Event::CaptureEnded { capture, why } => {
                    tracing::debug!(target: "domicile::engine::cast", ?capture, ?why, "the engine ended a capture");
                    let capturer = capturer(&mut self.engine, &mut self.cast_test_pattern);
                    self.casting.capture_ended(capture, why, capturer);
                }
                // A copy in a page or browser window. The browser is not our
                // Wayland client, so this is how its copies reach the seat and
                // the desktop has one clipboard.
                //
                // The engine is not told back; it already has the copy.
                engine::Event::Copied {
                    clipboard,
                    contents,
                } => {
                    let mimes = contents.mimes();
                    tracing::debug!(target: "domicile::engine::clipboard", ?clipboard, ?mimes, "a copy in the browser");
                    self.took_a_copy(clipboard, contents);
                    // Set the seat's selection, so Wayland clients can paste
                    // it.
                    match clipboard {
                        Clipboard::Copy => {
                            set_data_device_selection(
                                &self.display_handle,
                                &self.seat,
                                mimes.clone(),
                                Holder::Desk(clipboard),
                            );
                            self.hub.portals.selection_changed(mimes, None);
                        }
                        Clipboard::Primary => set_primary_selection(
                            &self.display_handle,
                            &self.seat,
                            mimes,
                            Holder::Desk(clipboard),
                        ),
                    }
                }
                // The engine holds DRM master, so on a tty this is the only
                // monitor report. `replugged_into` decides whether the engine
                // defines the desktop. `adopt_the_desktop` does nothing for an
                // unchanged list, which a modeset-triggered hotplug reports.
                engine::Event::Displays(displays) => {
                    // Kept so a config reload can match against the plugged-in
                    // monitors. Always the full list; anything absent is
                    // unplugged.
                    debug!(
                        target: "domicile::engine::displays",
                        displays = ?displays
                            .iter()
                            .map(|display| (
                                display.id,
                                &display.connector,
                                display.position,
                                display.size,
                                display.refresh_mhz,
                            ))
                            .collect::<Vec<_>>(),
                        "the engine's monitors (id, connector, position, size, refresh in mHz)"
                    );
                    self.engine_displays = displays.clone();
                    self.bind_the_pointers();
                    self.hub
                        .virtual_monitors
                        .set_extendable(self.config.current().output.desktop().is_none());
                    self.lay_out_the_engines_displays();
                    self.gamma_displays_reported();
                    // After the layout, which names the monitors the night
                    // light is set for.
                    self.restate_the_gamma();
                }
            }
        }
    }

    /// Tells the chromes each browser window's identifier on
    /// `ext-foreign-toplevel-list-v1`, if any changed.
    fn browser_toplevels_listed(&mut self, toplevel_ids: BTreeMap<String, String>) {
        // Separate `let` so the host guard drops before the broadcast.
        let listed = self
            .hub
            .host
            .lock()
            .unwrap()
            .browser_toplevel_ids(toplevel_ids);
        if let Some(listed) = listed {
            self.hub.broadcast(listed);
        }
    }

    /// A buffer the engine let go of goes back to whoever owns it: the client,
    /// as a `wl_buffer.release`, or the pool of the compositor's own.
    pub fn returned(&mut self, buffer: Submitted) {
        match buffer {
            Submitted::Client(buffer) => buffer.release(),
            Submitted::Upload(id) => self.uploads.give_back(id),
        }
    }

    /// Returns buffers the engine gave back to their clients, logging any viz
    /// held past the deadline.
    fn take_back(&mut self, releases: impl IntoIterator<Item = Release>) {
        for release in releases {
            match release.why {
                Returned::Released => {}
                // Include the app id: if only one window's buffers expire, viz
                // is probably not drawing that surface.
                Returned::Expired => {
                    // Separate messages so `app_id` only ever holds an app id.
                    // `window_gone` drops all holds when it forgets an app, so
                    // an unclaimed expiry means the window went first.
                    match self
                        .engine
                        .as_ref()
                        .and_then(|session| session.app_for(release.surface))
                    {
                        Some(app_id) => tracing::error!(
                            app_id,
                            "the engine never released a client buffer; taking it back so the \
                             client can draw. Something in viz is holding a dmabuf it has \
                             finished with"
                        ),
                        None => tracing::error!(
                            "the engine never released a buffer belonging to a window that has \
                             since gone; taking it back"
                        ),
                    }
                }
                Returned::Abandoned => {
                    tracing::debug!("a held buffer came back because its window went away")
                }
            }
            self.returned(release.buffer);
        }
    }

    /// Wakes the loop when the soonest superseded hold expires, unless a wake
    /// is armed.
    ///
    /// Viz may keep a buffer and send nothing, so the engine's fd alone would
    /// never apply the deadline. Taking it back lets a single-buffered client
    /// draw; tearing once and logging it is better than freezing it. A wake
    /// can come after its hold was released, and then only re-arms.
    pub fn arm_the_hold_deadline(&mut self) {
        if self.hold_deadline.is_some() {
            return;
        }
        let Some(due) = self.engine.as_ref().and_then(EngineSession::next_overdue) else {
            return;
        };
        let armed = self
            .loop_handle
            .insert_source(Timer::from_deadline(due), |_, _, data: &mut CalloopData| {
                let state = &mut data.state;
                state.hold_deadline = None;
                let overdue = state
                    .engine
                    .as_mut()
                    .map(|session| session.overdue(Instant::now()))
                    .unwrap_or_default();
                state.take_back(overdue);
                state.arm_the_hold_deadline();
                TimeoutAction::Drop
            })
            // Timers register nothing with the kernel, so inserting cannot
            // fail.
            .expect("the compositor's own loop takes a timer");
        self.hold_deadline = Some(armed);
    }

    /// Join an engine that replaced the current one, and restore what the old
    /// one knew.
    ///
    /// The compositor outlives its engine: `domicile-launch` can start a new
    /// engine under a running compositor (`domicile_launch::restart`), and
    /// clients keep their connection and windows. [`EngineSession::reconnect`]
    /// handles what the old browser created.
    ///
    /// Does nothing when the same engine's page reloads (`domicile
    /// load-shell`); see [`another_engine`].
    ///
    /// If the dial fails, it is logged and the session is kept. Held buffers
    /// are returned either way, and the next page hello retries.
    pub fn rejoin_the_engine(&mut self, served_by: Option<i32>) {
        let replaced = another_engine(self.engine_process, served_by, self.engine_disconnected);
        self.engine_disconnected = false;
        // Record the serving process for later hellos. Keep the old one if the
        // kernel gave no credential.
        self.engine_process = served_by.or(self.engine_process);
        if !replaced || self.engine.is_none() {
            return;
        }
        warn!(
            served_by,
            "the engine this desktop was drawing through has been replaced; rejoining it"
        );
        // The old engine's captures are gone with it, and it reports no more
        // frames.
        self.casting.engine_replaced();
        let unreported = self.frame_callbacks.take_all();
        self.answer_unreported(unreported);
        let session = self
            .engine
            .as_mut()
            .expect("a desktop with no engine has nothing to rejoin, and said so above");
        // The dmabuf is reference-counted, and the session holds the client's
        // buffer, so its fds are still valid. shm windows resubmit their
        // compositor-owned copy.
        let uploads = &self.uploads;
        let rejoined = session.reconnect(
            &|submitted| match submitted {
                Submitted::Client(buffer) => match committed_buffer(buffer) {
                    Some(CommittedBuffer::Gpu(dmabuf)) => {
                        Some(FrameDescriptor::Dmabuf(descriptor_from(&dmabuf)))
                    }
                    Some(CommittedBuffer::Pixels { .. }) | None => None,
                },
                Submitted::Upload(id) => uploads.get(*id).map(Upload::describe),
            },
            Instant::now(),
        );
        match &rejoined.dialed {
            Ok(()) => {
                self.engine
                    .as_ref()
                    .expect("the engine was rejoined")
                    .configure_input(&self.config.current().input);
                thread_priority::raise_the_engine_thread();
                self.watch_the_engines_fd();
                // The new engine numbers its boxes afresh, and shows none of
                // the old one's frames.
                self.configure_answers.clear();
                self.shown.clear();
                self.presentations.clear();
                // The new engine does not know the profile, and
                // `Screens::replugged_into` ignores an unchanged list, so
                // restate the connectors or disabled ones come back lit.
                self.state_the_connectors();
                // The new browser starts with empty clipboards, so restore
                // them.
                self.tell_the_engine_the_copies();
                // And with no virtual monitors.
                self.state_the_virtual_monitors();
                debug!(
                    shown = rejoined.shown.len(),
                    blank = rejoined.blank.len(),
                    returned = rejoined.releases.len(),
                    "rejoined the engine and restated this desktop to it"
                );
            }
            Err(err) => error!(
                %err,
                "there is a new engine at the broker socket and this compositor could not \
                 join it; every window on this desktop will be blank until one it can join \
                 arrives"
            ),
        }
        for app_id in &rejoined.blank {
            error!(
                app_id,
                "this window's last frame could not be put back on the new engine, so it is \
                 on the page with nothing in it until its client draws again"
            );
        }
        // Return every buffer the old engine held, joined or not. A client owed
        // a release never draws again.
        for release in rejoined.releases {
            self.returned(release.buffer);
        }
    }

    /// Watch the current engine's fd, and stop watching the previous one.
    ///
    /// The old fd is closed with its engine, and a source left on it would
    /// spin.
    fn watch_the_engines_fd(&mut self) {
        if let Some(watching) = self.engine_source.take() {
            self.loop_handle.remove(watching);
        }
        let Some(session) = self.engine.as_ref() else {
            return;
        };
        match poll_the_engine(&self.loop_handle, session.fd()) {
            Ok(watching) => self.engine_source = Some(watching),
            // Logged, not fatal. Without the watch nothing from the engine is
            // heard, but ending every client over it would defeat the
            // compositor outliving its engine.
            Err(err) => error!(
                %err,
                "the engine's fd could not be watched, so nothing it says will be heard; \
                 this desktop is still serving its clients and has to be restarted to draw"
            ),
        }
    }
}

/// Watch the engine's fd, so [`DomicileCompositor::pump_the_engine`] runs when
/// the engine has events.
///
/// Separate because a replacement engine brings a new fd.
pub fn poll_the_engine(
    handle: &LoopHandle<'static, CalloopData>,
    fd: std::os::fd::RawFd,
) -> Result<RegistrationToken, Box<dyn std::error::Error>> {
    // Duplicate the fd: the source outlives this call, and the engine closes
    // the original when dropped.
    //
    // SAFETY: the fd belongs to the live engine and is valid until it is
    // destroyed. It is duplicated before this returns and never used as a
    // borrow afterward.
    let owned = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
    Ok(handle.insert_source(
        Generic::new(owned, Interest::READ, Mode::Level),
        |_, _, data: &mut CalloopData| {
            data.state.pump_the_engine();
            data.state.arm_the_hold_deadline();
            Ok(PostAction::Continue)
        },
    )?)
}
