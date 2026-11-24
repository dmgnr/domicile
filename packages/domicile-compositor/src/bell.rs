//! `xdg_system_bell_v1`: a client rings the bell, and the shell hears it with
//! the window that rang. The compositor makes no sound; see
//! `docs/WRITING-A-SHELL.md`.

use smithay::delegate_xdg_system_bell;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::wayland::xdg_system_bell::XdgSystemBellHandler;
use tracing::debug;

use crate::DomicileCompositor;

impl XdgSystemBellHandler for DomicileCompositor {
    fn ring(&mut self, surface: Option<WlSurface>) {
        // A popup or subsurface rings for the window under it.
        let app_id = surface.and_then(|surface| self.window_of(&surface));
        debug!(?app_id, "a bell -> the shell");
        self.hub.outbound.bell(app_id);
    }
}

delegate_xdg_system_bell!(DomicileCompositor);
