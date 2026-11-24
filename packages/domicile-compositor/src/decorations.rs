//! Window decorations. The shell draws every window's frame, so both decoration
//! protocols always answer "server side". Clients may still draw their own (GTK4
//! does); see `window_geometry.rs`.

use std::sync::atomic::{AtomicBool, Ordering};

use smithay::reexports::{
    wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecorationMode,
    wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::{
        Mode as KdeMode, OrgKdeKwinServerDecoration,
    },
    wayland_server::{protocol::wl_surface::WlSurface, WEnum},
};
use smithay::wayland::{
    compositor::with_states,
    shell::kde::decoration::{KdeDecorationHandler, KdeDecorationState},
    shell::xdg::decoration::XdgDecorationHandler,
    shell::xdg::ToplevelSurface,
};
use smithay::{delegate_kde_decoration, delegate_xdg_decoration};

use crate::DomicileCompositor;

impl XdgDecorationHandler for DomicileCompositor {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        shell_draws_the_frame(&toplevel);
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, mode: XdgDecorationMode) {
        ask_to_draw_its_frame(toplevel.wl_surface(), mode == XdgDecorationMode::ClientSide);
        shell_draws_the_frame(&toplevel);
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        ask_to_draw_its_frame(toplevel.wl_surface(), false);
        shell_draws_the_frame(&toplevel);
    }
}

delegate_xdg_decoration!(DomicileCompositor);

/// Tell `toplevel` the shell draws its frame.
///
/// Before the first configure, the mode rides on the initial configure from
/// `commit`, as the protocol requires.
fn shell_draws_the_frame(toplevel: &ToplevelSurface) {
    toplevel.with_pending_state(|state| {
        state.decoration_mode = Some(XdgDecorationMode::ServerSide);
    });
    if toplevel.is_initial_configure_sent() {
        toplevel.send_pending_configure();
    }
}

impl KdeDecorationHandler for DomicileCompositor {
    fn kde_decoration_state(&self) -> &KdeDecorationState {
        &self.kde_decoration_state
    }

    /// Say "server side" once, when the decoration is created, as the protocol
    /// asks.
    fn new_decoration(&mut self, _surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration) {
        decoration.mode(KdeMode::Server);
    }

    /// Record the ask without answering it. GTK3 and Firefox answer every
    /// `mode(Server)` by asking for client side again, so answering each ask
    /// loops forever (#2466).
    fn request_mode(
        &mut self,
        surface: &WlSurface,
        _decoration: &OrgKdeKwinServerDecoration,
        mode: WEnum<KdeMode>,
    ) {
        ask_to_draw_its_frame(surface, mode == WEnum::Value(KdeMode::Client));
    }
}

delegate_kde_decoration!(DomicileCompositor);

/// Whether a window's client asked to draw its own frame, kept on its surface.
/// Reported in [`HostMessage::AppAppeared`]; the answer is always "server
/// side".
struct AsksToDrawItsFrame(AtomicBool);

/// Record whether `surface`'s client last asked to draw its own frame.
fn ask_to_draw_its_frame(surface: &WlSurface, asks: bool) {
    with_states(surface, |states| {
        states
            .data_map
            .insert_if_missing_threadsafe(|| AsksToDrawItsFrame(AtomicBool::new(false)));
        states
            .data_map
            .get::<AsksToDrawItsFrame>()
            .expect("inserted above")
            .0
            .store(asks, Ordering::Relaxed);
    });
}

/// Whether `surface`'s client last asked to draw its own frame.
pub fn asks_to_draw_its_frame(surface: &WlSurface) -> bool {
    with_states(surface, |states| {
        states
            .data_map
            .get::<AsksToDrawItsFrame>()
            .is_some_and(|asks| asks.0.load(Ordering::Relaxed))
    })
}
