//! Wayland clients: the socket or sandbox each came from, and which globals it
//! sees.

use std::os::unix::net::UnixStream;
use std::sync::Arc;

use smithay::delegate_security_context;
use smithay::reexports::wayland_server::{
    backend::{ClientData, ClientId, DisconnectReason},
    protocol::wl_surface::WlSurface,
    Client, DisplayHandle, Resource as _,
};
use smithay::wayland::{
    compositor::CompositorClientState,
    security_context::{SecurityContext, SecurityContextHandler, SecurityContextListenerSource},
};
use tracing::debug;

use domicile_protocol::{Owner, Sandbox};

use crate::peer_process::peer_owner;
use crate::{grepped, CalloopData, DomicileCompositor};

/// Per-client state required by the compositor global.
#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
    /// Whether this client connected on the chrome's socket, making it the
    /// engine rather than an app.
    ///
    /// The socket identifies it because clients cannot spoof it. An
    /// `xdg_toplevel` app id is client-set and may arrive after the toplevel.
    is_chrome: bool,
    /// The process that connected, read from the socket on arrival. `None`
    /// for the chrome, which owns no window.
    owner: Option<Owner>,
}

impl ClientState {
    fn app(owner: Owner) -> Self {
        ClientState {
            owner: Some(owner),
            ..ClientState::default()
        }
    }

    /// Whether this client may see privileged globals. See
    /// [`sees_privileged_globals`].
    fn is_privileged(&self) -> bool {
        match &self.owner {
            Some(owner) => owner.sandbox.is_none(),
            None => true,
        }
    }

    pub fn chrome() -> Self {
        ClientState {
            is_chrome: true,
            ..ClientState::default()
        }
    }
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}

/// Whether `client` may see privileged globals: data control, screen capture
/// and `wp_security_context_manager_v1`. A client that connected through a
/// security context may not; the protocol requires the last.
///
/// Every privileged global filters on this.
pub fn sees_privileged_globals(client: &Client) -> bool {
    client
        .get_data::<ClientState>()
        .is_some_and(ClientState::is_privileged)
}

/// Accepts an app client on `stream`, from `sandbox` if it came through a
/// security context's listener.
pub fn accept_app_client(mut display: DisplayHandle, stream: UnixStream, sandbox: Option<Sandbox>) {
    // Before `insert_client`, which takes the stream.
    let owner = match peer_owner(&stream) {
        Ok(owner) => Owner { sandbox, ..owner },
        Err(err) => {
            // A window whose owner the shell cannot know is refused rather
            // than shown unattributed.
            tracing::error!(%err, "a client's credentials would not read; refusing it");
            return;
        }
    };
    // Pairs with `spawning client` to time a launch.
    debug!(pid = owner.pid, "{}", grepped::ARRIVED);
    display
        .insert_client(stream, Arc::new(ClientState::app(owner)))
        .expect("failed to insert client");
}

/// The process that connected `surface`'s client.
///
/// Panics for the chrome's surfaces and dead clients: the caller has already
/// ruled both out.
pub fn owner_of(surface: &WlSurface) -> Owner {
    surface
        .client()
        .and_then(|client: Client| {
            client
                .get_data::<ClientState>()
                .and_then(|data| data.owner.clone())
        })
        .expect("an app's client is alive and was read on arrival")
}

/// Whether `surface` belongs to the chrome rather than to an app.
pub fn is_chrome_surface(surface: &WlSurface) -> bool {
    surface
        .client()
        .and_then(|client: Client| client.get_data::<ClientState>().map(|data| data.is_chrome))
        .unwrap_or(false)
}

impl SecurityContextHandler for DomicileCompositor {
    /// Accepts on a sandbox's listener, marking each client with the sandbox.
    fn context_created(&mut self, source: SecurityContextListenerSource, context: SecurityContext) {
        let sandbox = Sandbox {
            engine: context.sandbox_engine,
            app_id: context.app_id,
            instance_id: context.instance_id,
        };
        debug!(?sandbox, "a sandbox opened a listener");
        let listening =
            self.loop_handle
                .insert_source(source, move |stream, _, data: &mut CalloopData| {
                    accept_app_client(data.display.handle(), stream, Some(sandbox.clone()));
                });
        if let Err(err) = listening {
            // Dropping the source closes the listener, so the sandbox's
            // clients fail to connect rather than connect unmarked.
            tracing::error!(%err, "a sandbox's listener would not join the event loop");
        }
    }
}

delegate_security_context!(DomicileCompositor);
