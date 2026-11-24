//! Outputs and scale: the `wl_output`s advertised for the desktop's displays, and
//! which displays and scale each window is on.

use std::time::Duration;

use smithay::output::{Mode as OutputMode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::wayland_server::{protocol::wl_surface::WlSurface, DisplayHandle};
use smithay::utils::Transform;
use smithay::wayland::{
    compositor::with_states,
    fractional_scale::{with_fractional_scale, FractionalScaleHandler},
    output::OutputHandler,
    shell::xdg::ToplevelSurface,
};
use smithay::{delegate_fractional_scale, delegate_output};
use tracing::{debug, info};

use domicile_config::Config;

use crate::color_management::Description;
use crate::eis::barriers::Zone;
use crate::screens::{pointer_targets, Advertised, Screens, Slot};
use crate::{grepped, CalloopData, DomicileCompositor};

/// The desktop a config describes, at startup.
///
/// Reloads use [`Screens::reloaded_into`], which may keep the current desktop.
/// At startup nothing has been negotiated yet.
pub fn screens_at_startup(config: &Config) -> Screens {
    match config.output.desktop() {
        Some(desktop) => Screens::described(&desktop),
        None => Screens::nested(),
    }
}

/// How long a retired display's global stays bound-to before it is removed.
/// See [`DomicileCompositor::retire_output`].
const RETIRED_OUTPUT_GRACE: Duration = Duration::from_secs(5);

/// An advertised `wl_output` and its global.
///
/// The global id is kept for removal: `DisplayHandle::remove_global` is how
/// clients learn a display is gone. Dropping the `Output` alone leaves it
/// advertised.
pub struct LiveOutput {
    pub output: Output,
    global: smithay::reexports::wayland_server::backend::GlobalId,
}

/// Advertise `advertised` as a new `wl_output`.
///
/// The only place outputs are created, so startup and reload advertise the same
/// thing.
pub fn advertise_output(dh: &DisplayHandle, advertised: &Advertised) -> LiveOutput {
    let output = Output::new(
        advertised.name.clone(),
        PhysicalProperties {
            // Real millimeters on a tty, from the engine's EDID read. Otherwise
            // `screens::UNKNOWN_PHYSICAL_MM` (zero, `wl_output`'s "unknown"): a
            // described desktop or nested window has no physical size. Not
            // invented here, because toolkits size fonts from it.
            size: advertised.physical_mm.into(),
            subpixel: Subpixel::Unknown,
            make: "Domicile".into(),
            // The panel's name, if known. Clients read it to identify monitors.
            //
            // It also reaches `xdg_output.description`: Smithay builds that
            // once as "{make} - {model} - {name}" with no setter
            // (`output.rs:264`).
            //
            // "Virtual" for outputs that are not panels.
            model: if advertised.description.is_empty() {
                "Virtual".into()
            } else {
                advertised.description.clone()
            },
        },
    );
    let global = output.create_global::<DomicileCompositor>(dh);
    restate_output(&output, advertised);
    LiveOutput { output, global }
}

/// Update an existing output's mode, transform, scale and position.
///
/// A display that only changed shape keeps its `wl_output`; see [`Slot::Kept`].
///
/// Physical size is fixed at construction and cannot change for a kept output:
/// it is matched by name, which comes from the EDID. A renamed output goes
/// through [`advertise_output`].
fn restate_output(output: &Output, advertised: &Advertised) {
    let mode = current_mode(advertised);
    output.change_current_state(
        Some(mode),
        Some(as_wl_transform(advertised.transform)),
        // Fractional, so `xdg_output` reports the true logical size. Smithay
        // rounds the `wl_output.scale` it sends up from this, which a 1.2x
        // display needs.
        Some(Scale::Fractional(advertised.scale)),
        Some(advertised.position.into()),
    );
    output.set_preferred(mode);
}

/// A display's current mode as a `wl_output` mode.
///
/// Shared by startup and `set_output`, so a density change does not look like
/// new hardware.
fn current_mode(advertised: &Advertised) -> OutputMode {
    OutputMode {
        size: advertised.mode.into(),
        refresh: advertised.refresh_mhz,
    }
}

/// Convert a config transform to Smithay's.
///
/// `screens.rs` avoids Smithay for testability and `domicile-config` has no
/// Smithay dependency, so the conversion lives here. Rotations only.
pub(crate) fn as_wl_transform(transform: domicile_config::Transform) -> Transform {
    match transform {
        domicile_config::Transform::Normal => Transform::Normal,
        domicile_config::Transform::Rotate90 => Transform::_90,
        domicile_config::Transform::Rotate180 => Transform::_180,
        domicile_config::Transform::Rotate270 => Transform::_270,
    }
}

impl OutputHandler for DomicileCompositor {}

delegate_output!(DomicileCompositor);

impl FractionalScaleHandler for DomicileCompositor {
    /// A client asked for its surface's scale, often before the surface has a
    /// role.
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        self.prefer_scale(&surface, self.bounds_of(&surface));
    }
}

delegate_fractional_scale!(DomicileCompositor);

impl DomicileCompositor {
    /// Advertise a new output scale, so clients redraw at the screen's
    /// resolution.
    ///
    /// Applies only to a window-following desktop; a described desktop sets its
    /// own scale.
    pub fn set_output_scale(&mut self, scale: i32) {
        if !self.screens.follows_the_window() {
            // Logged because the refusal is otherwise invisible, to users and
            // to tests.
            debug!(scale, "{}", grepped::DENSITY_REFUSED);
            return;
        }
        let logical = self.screens.size();
        self.set_output(logical, scale);
    }

    /// Advertise a new desktop size reported by the chrome.
    ///
    /// Like `set_output_scale`, refused (and logged) on a described desktop:
    /// resizing Domicile's window then shows more or less of the configured
    /// screens. The scale is kept.
    pub fn set_output_size(&mut self, logical: (i32, i32)) {
        if !self.screens.follows_the_window() {
            debug!(
                width = logical.0,
                height = logical.1,
                "{}",
                grepped::SIZE_REFUSED
            );
            return;
        }
        let scale = self
            .screens
            .outputs()
            .next()
            .expect("a window-following desktop advertises its one output")
            .wl_output_scale();
        self.set_output(logical, scale);
    }

    /// Advertise the desktop's size and scale together, since a mode is both.
    ///
    /// Only for a window-following desktop, which has one output. On a
    /// described desktop it would leave `self.screens` and `self.outputs`
    /// disagreeing. Callers guard this and it is asserted.
    pub fn set_output(&mut self, logical: (i32, i32), scale: i32) {
        assert!(
            self.screens.follows_the_window(),
            "a described desktop is the config's, not this function's to replace"
        );
        // Read both from `Screens`, the single source for size and scale.
        let advertised = self
            .screens
            .outputs()
            .next()
            .expect("a window-following desktop advertises its one output");
        if self.screens.size() == logical && advertised.wl_output_scale() == scale {
            return;
        }
        debug!(
            width = logical.0,
            height = logical.1,
            scale,
            "{}",
            grepped::ADVERTISING
        );
        self.screens = Screens::following_the_window(logical, scale);
        self.tell_the_casts_the_screens();
        // The mode is in physical pixels, so it grows with the scale to keep
        // the logical size. Read from the new `Screens`.
        let mode = current_mode(
            self.screens
                .outputs()
                .next()
                .expect("a window-following desktop advertises its one output"),
        );
        let output = &self
            .outputs
            .first()
            .expect("a window-following desktop advertises its one output")
            .output;
        output.change_current_state(Some(mode), None, Some(Scale::Integer(scale)), None);
        output.set_preferred(mode);
        // Clients that draw at a fractional scale read it from here, not from
        // the output.
        self.enter_the_displays_each_window_is_on();
        // Re-send the existing configure to prompt clients to redraw at the new
        // scale.
        for (_, toplevel) in &self.toplevels {
            toplevel.send_configure();
        }
        // The chrome covers the desktop, so it must be resized with it.
        if let Some(chrome) = self.chrome_toplevel.clone() {
            chrome.with_pending_state(|state| {
                state.size = Some(logical.into());
            });
            chrome.send_configure();
        }
        // Update the display list the chrome lays out against (`<Screen>`
        // positions). Store it for chromes that connect later and broadcast it
        // to connected ones.
        //
        // Describe then broadcast, on this thread. [`freshened`] relies on that
        // order.
        let desktop = {
            let mut host = self.hub.host.lock().unwrap();
            host.describe_displays(self.screens.outputs().map(Advertised::described).collect());
            host.describe_monitors(self.screens.outputs().map(Advertised::monitor).collect());
            host.describe_desktop()
        };
        self.hub.broadcast(desktop);
        self.hub
            .portals
            .displays(self.screens.outputs().map(Zone::from).collect());
    }

    /// Tell the engine which display each tablet or touchscreen covers.
    ///
    /// Sent on every display report and reload, because the targets are the
    /// engine's display ids. Nested, the engine ignores it.
    pub fn bind_the_pointers(&self) {
        let Some(session) = self.engine.as_ref() else {
            return;
        };
        session.configure_pointers(&pointer_targets(
            &self.engine_displays,
            &self.config.current().input,
            &self.vendors,
        ));
    }

    /// Apply a desktop the config now describes, keeping displays that stayed.
    ///
    /// The only path that can add or remove displays. Works for either kind of
    /// desktop, including a config that stopped describing one.
    ///
    /// Does nothing if the desktop is unchanged, since config files are
    /// rewritten often and editors' atomic saves fire several events.
    ///
    /// Only handles displays.
    /// [`adopt_the_rest_of_the_config`](DomicileCompositor::adopt_the_rest_of_the_config)
    /// runs right after for the rest; [`crate::restatement`] lists which field
    /// takes which path.
    pub fn adopt_the_desktop(&mut self, dh: &DisplayHandle, screens: Screens) {
        if screens == self.screens {
            return;
        }
        let plan = self.screens.rearranged_into(&screens);
        info!(
            displays = screens.outputs().count(),
            retired = plan.retired.len(),
            "taking up a reloaded desktop"
        );
        for advertised in screens.outputs() {
            debug!(
                name = %advertised.name,
                connector = %advertised.connector,
                display = ?advertised.display,
                position = ?advertised.position,
                logical = ?advertised.logical,
                mode = ?advertised.mode,
                scale = advertised.scale,
                transform = ?advertised.transform,
                refresh_mhz = advertised.refresh_mhz,
                adaptive_sync = ?advertised.adaptive_sync,
                hdr = ?advertised.hdr,
                "a display of the new desktop"
            );
        }
        // Move all old outputs out first; the new list takes those it keeps,
        // and the rest are retired.
        let mut had: Vec<Option<LiveOutput>> = self.outputs.drain(..).map(Some).collect();
        let outputs: Vec<LiveOutput> = plan
            .slots
            .iter()
            .zip(screens.outputs())
            .map(|(slot, advertised)| match slot {
                Slot::Kept(index) => {
                    // Unreachable: display names are unique
                    // (`OutputConfig::validate`), and `rearranged_into` matches
                    // by name. Asserted so one `wl_output` is never advertised
                    // as two displays.
                    let live = had[*index]
                        .take()
                        .expect("no two displays share one output");
                    restate_output(&live.output, advertised);
                    live
                }
                Slot::New => advertise_output(dh, advertised),
            })
            .collect();
        // `retired` holds exactly the indices no slot kept, so loop order does
        // not matter.
        for retired in plan.retired {
            let live = had[retired]
                .take()
                .expect("a retired output is one no slot kept");
            self.retire_output(dh, live);
        }
        self.outputs = outputs;
        self.screens = screens;
        self.display_colors.restate(&self.screens);
        self.tell_the_casts_the_screens();
        // Tell the engine, which holds DRM master, which connectors to light. A
        // profile that turns a panel off needs the panel actually turned off.
        //
        // Sent on every adoption, even an empty list, which undoes a profile
        // whose displays are unplugged (see `Screens::scanout`).
        //
        // Through `state_the_connectors` so a blanked desktop stays blanked
        // through reloads and hotplugs.
        self.state_the_connectors();
        // The chrome is on every display, so tell it about new ones. Toolkits
        // pick their density from this.
        if let Some(chrome) = self.chrome_toplevel.clone() {
            for live in &self.outputs {
                live.output.enter(chrome.wl_surface());
            }
            // Resize it to the new desktop. Always sent, because the desktop
            // can change (a rename, a scale) without its bounding box changing.
            // A repeated configure is a no-op.
            chrome.with_pending_state(|state| {
                state.size = Some(self.screens.size().into());
            });
            chrome.send_configure();
        }
        // Displays may have moved under windows that did not.
        self.enter_the_displays_each_window_is_on();
        // Prompt clients to redraw at any new scale.
        for (_, toplevel) in &self.toplevels {
            toplevel.send_configure();
        }
        // Describe then broadcast on this thread, as in `set_output`.
        let desktop = {
            let mut host = self.hub.host.lock().unwrap();
            host.describe_displays(self.screens.outputs().map(Advertised::described).collect());
            host.describe_monitors(self.screens.outputs().map(Advertised::monitor).collect());
            host.describe_desktop()
        };
        self.hub.broadcast(desktop);
        self.hub
            .portals
            .displays(self.screens.outputs().map(Zone::from).collect());
    }

    /// Withdraw `live`'s global, and free it once clients have heard.
    ///
    /// Removing a global at once kills any client whose `bind` crossed the
    /// `global_remove` in flight, and frees its name for the next display to
    /// reuse, so a late bind can land on the wrong global. So it is
    /// disabled now and removed after [`RETIRED_OUTPUT_GRACE`], as wlroots
    /// does. Dropping only the `Output` would leave it advertised for the rest
    /// of the run.
    fn retire_output(&self, dh: &DisplayHandle, live: LiveOutput) {
        dh.disable_global::<DomicileCompositor>(live.global.clone());
        self.loop_handle
            .insert_source(
                Timer::from_duration(RETIRED_OUTPUT_GRACE),
                move |_, _, data: &mut CalloopData| {
                    data.display
                        .handle()
                        .remove_global::<DomicileCompositor>(live.global.clone());
                    TimeoutAction::Drop
                },
            )
            // Timers register nothing with the kernel, so inserting cannot
            // fail.
            .expect("the compositor's own loop takes a timer");
    }

    /// Tell every client which displays its windows and popups are on, and
    /// the scale to draw at.
    ///
    /// Runs when the displays or their scales change. A window the page moves
    /// (`ChromeMessage::SetAppBounds`) is placed alone with its popups, and a
    /// new or repositioned popup alone, with [`place_window`](Self::place_window). Smithay only sends
    /// `enter`/`leave` and the preferred scale when they change.
    ///
    /// The chrome's own toplevel only gets its scale here. It belongs on every
    /// output, which `new_toplevel` and
    /// [`adopt_the_desktop`](DomicileCompositor::adopt_the_desktop) enter.
    pub fn enter_the_displays_each_window_is_on(&self) {
        for (app_id, toplevel) in &self.toplevels {
            self.place_window(toplevel.wl_surface(), self.app_bounds.get(app_id).copied());
        }
        for popup in self.xdg_shell_state.popup_surfaces() {
            self.place_window(popup.wl_surface(), self.popup_bounds(popup));
        }
        self.put_the_candidates_on_their_display();
        // The chrome covers every display, so it draws for the densest.
        if let Some(chrome) = &self.chrome_toplevel {
            self.prefer_scale(chrome.wl_surface(), None);
        }
    }

    /// Put `surface` on the displays `bounds` overlaps, at the scale of the one
    /// holding most of it. `None` is every display, at the densest scale.
    pub fn place_window(&self, surface: &WlSurface, bounds: Option<domicile_scene::Bounds>) {
        self.enter_only(surface, bounds);
        self.prefer_scale(surface, bounds);
        crate::color_management::prefer(
            surface,
            Description::of_display(&self.screens.hdr_for(bounds)),
        );
    }

    /// Record window `app_id`'s new CSS `zoom` and tell it, and its popups,
    /// the scale that makes.
    pub fn zoom_window(&mut self, app_id: &str, toplevel: &ToplevelSurface, zoom: f64) {
        if zoom == 1.0 {
            self.app_zoom.remove(app_id);
        } else {
            self.app_zoom.insert(app_id.to_owned(), zoom);
        }
        self.place_window(toplevel.wl_surface(), self.app_bounds.get(app_id).copied());
        self.place_the_popups_over(toplevel.wl_surface());
    }

    /// Send `wp_fractional_scale_v1.preferred_scale` for a window in `bounds`:
    /// the display's scale ([`Screens::scale_for`]) times the window's CSS
    /// `zoom` ([`crate::scale::zoomed`]).
    fn prefer_scale(&self, surface: &WlSurface, bounds: Option<domicile_scene::Bounds>) {
        let scale = crate::scale::zoomed(self.screens.scale_for(bounds), self.zoom_of(surface));
        with_states(surface, |states| {
            with_fractional_scale(states, |fractional| fractional.set_preferred_scale(scale));
        });
    }

    /// Enter `surface` on the displays `bounds` reaches and leave the rest.
    ///
    /// Zips outputs positionally with [`Screens::entered_by`]; see the
    /// `outputs` field for why that is safe.
    fn enter_only(&self, surface: &WlSurface, bounds: Option<domicile_scene::Bounds>) {
        for (live, entered) in self.outputs.iter().zip(self.screens.entered_by(bounds)) {
            let output = &live.output;
            if entered {
                output.enter(surface);
            } else {
                output.leave(surface);
            }
        }
    }
}
