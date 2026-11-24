//! `zwlr_gamma_control_manager_v1`: a client sets one monitor's gamma ramp,
//! as gammastep and wl-gammarelay-rs do. [`crate::gamma`] decides who owns a
//! monitor's ramp; this is the protocol around it, and the night light's way
//! to the engine.

use std::io::{ErrorKind, Read as _};
use std::os::fd::OwnedFd;
use std::time::{Duration, Instant};

use smithay::output::Output;
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::wayland_protocols_wlr::gamma_control::v1::server::{
    zwlr_gamma_control_manager_v1::{self, ZwlrGammaControlManagerV1},
    zwlr_gamma_control_v1::{self, ZwlrGammaControlV1},
};
use smithay::reexports::wayland_server::protocol::wl_output::WlOutput;
use smithay::reexports::wayland_server::{
    backend::ClientId, Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
};
use tracing::{debug, warn};

use crate::clipboard::without_blocking;
use crate::engine::HdrState;
use crate::{CalloopData, DomicileCompositor};

/// How often the night light is drawn while it fades.
const FADE_FRAME: Duration = Duration::from_millis(16);

/// Advertises the manager.
pub fn advertise(display: &DisplayHandle) {
    display.create_global::<DomicileCompositor, ZwlrGammaControlManagerV1, _>(1, ());
}

impl DomicileCompositor {
    /// Draws the night light as it is now, and again each [`FADE_FRAME`]
    /// until its fade ends. Nothing is drawn between fades.
    pub fn draw_the_night_light(&mut self) {
        let now = Instant::now();
        self.gamma.set_lights(self.night_light.at(now));
        self.restate_the_gamma();
        if self.night_light.fading(now) && !self.night_light_frame_due {
            self.night_light_frame_due = true;
            self.loop_handle
                .insert_source(
                    Timer::from_duration(FADE_FRAME),
                    |_, _, data: &mut CalloopData| {
                        data.state.night_light_frame_due = false;
                        data.state.draw_the_night_light();
                        TimeoutAction::Drop
                    },
                )
                // Timers register nothing with the kernel, so inserting cannot
                // fail.
                .expect("the compositor's own loop takes a timer");
        }
    }

    /// Sends every engine display its ramp. Run when the displays, a night
    /// light or a client's hold change.
    pub fn restate_the_gamma(&self) {
        for display in &self.engine_displays {
            self.restate_the_gamma_of(display.id);
        }
    }

    /// Sends engine display `display` its ramp, if it has gamma, and its color
    /// matrix, which carries the night light in HDR or with no gamma.
    fn restate_the_gamma_of(&self, display: i64) {
        let Some(session) = self.engine.as_ref() else {
            return;
        };
        let output = self
            .screens
            .outputs()
            .find(|advertised| advertised.display == Some(display))
            .map(|advertised| advertised.name.as_str());
        if let Some(ramp) = self.gamma.ramp(display, output) {
            session.set_gamma(display, &ramp);
        }
        session.set_color_matrix(display, &self.gamma.matrix(display, output));
    }

    /// Takes which engine displays are on a connector and which are driven in
    /// HDR. A client holding one that went into HDR hears `failed`: its ramp
    /// assumes SDR.
    pub fn gamma_displays_reported(&mut self) {
        let connected = self
            .engine_displays
            .iter()
            .filter(|display| !display.connector.is_empty())
            .map(|display| display.id)
            .collect();
        self.gamma.set_connected(connected);
        let hdr = self
            .engine_displays
            .iter()
            .filter(|display| display.hdr.state == HdrState::On)
            .map(|display| display.id)
            .collect();
        for lost in self.gamma.set_hdr(hdr) {
            debug!(control = ?lost.id(), "gamma control: its monitor went into HDR");
            lost.failed();
        }
    }

    /// Takes the engine's ramp sizes. A client whose monitor lost its gamma
    /// hears `failed`.
    pub fn gamma_sizes_reported(&mut self, sizes: std::collections::HashMap<i64, u32>) {
        for lost in self.gamma.set_sizes(sizes) {
            debug!(control = ?lost.id(), "gamma control: its monitor has no gamma now");
            lost.failed();
        }
    }

    /// The engine display `output` shows, if any.
    fn engine_display_of(&self, output: &WlOutput) -> Option<i64> {
        let name = Output::from_resource(output)?.name();
        self.screens
            .outputs()
            .find(|advertised| advertised.name == name)?
            .display
    }

    fn gamma_control_asked(&mut self, control: ZwlrGammaControlV1, output: &WlOutput) {
        let monitor = self.engine_display_of(output);
        match self.gamma.hold(monitor, control.clone()) {
            Ok(size) => {
                debug!(?monitor, size, "gamma control: a client holds a monitor");
                control.gamma_size(size);
            }
            Err(refused) => {
                debug!(?monitor, ?refused, "gamma control: refused");
                control.failed();
            }
        }
    }

    fn gamma_set(&mut self, control: &ZwlrGammaControlV1, fd: OwnedFd) {
        let ramp = match read_ramp(fd) {
            Ok(ramp) => ramp,
            Err(error) => {
                warn!(%error, "gamma control: could not read a client's ramp");
                self.gamma_released(control);
                control.failed();
                return;
            }
        };
        match self.gamma.set(control, ramp) {
            Ok(Some(display)) => self.restate_the_gamma_of(display),
            // Refused or let go already, and told so then.
            Ok(None) => {}
            Err(wrong) => control.post_error(
                zwlr_gamma_control_v1::Error::InvalidGamma,
                format!(
                    "a gamma table is three ramps of gamma_size 16-bit entries: {} of them",
                    wrong.expected
                ),
            ),
        }
    }

    fn gamma_released(&mut self, control: &ZwlrGammaControlV1) {
        if let Some(monitor) = self.gamma.release(control) {
            debug!(monitor, "gamma control: a client let go of a monitor");
            self.restate_the_gamma_of(monitor);
        }
    }
}

/// Reads a client's gamma table: what `fd` holds now, as native-endian 16-bit
/// entries. Never waits on a pipe the client has not filled, as wlroots does
/// not: the compositor's loop would stall.
fn read_ramp(fd: OwnedFd) -> std::io::Result<Vec<u16>> {
    let mut bytes = Vec::new();
    match without_blocking(fd)?.read_to_end(&mut bytes) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::WouldBlock => {}
        Err(error) => return Err(error),
    }
    if bytes.len() % 2 != 0 {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "a gamma table of an odd number of bytes",
        ));
    }
    let (pairs, _) = bytes.as_chunks::<2>();
    Ok(pairs.iter().map(|&pair| u16::from_ne_bytes(pair)).collect())
}

impl GlobalDispatch<ZwlrGammaControlManagerV1, ()> for DomicileCompositor {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<ZwlrGammaControlManagerV1>,
        _: &(),
        data_init: &mut DataInit<'_, Self>,
    ) {
        data_init.init(resource, ());
    }

    /// Colors on every monitor are no sandboxed app's to change.
    fn can_view(client: Client, _: &()) -> bool {
        crate::clients::sees_privileged_globals(&client)
    }
}

impl Dispatch<ZwlrGammaControlManagerV1, ()> for DomicileCompositor {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &ZwlrGammaControlManagerV1,
        request: zwlr_gamma_control_manager_v1::Request,
        _: &(),
        _: &DisplayHandle,
        data_init: &mut DataInit<'_, Self>,
    ) {
        match request {
            zwlr_gamma_control_manager_v1::Request::GetGammaControl { id, output } => {
                let control = data_init.init(id, ());
                state.gamma_control_asked(control, &output);
            }
            zwlr_gamma_control_manager_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }
}

impl Dispatch<ZwlrGammaControlV1, ()> for DomicileCompositor {
    fn request(
        state: &mut Self,
        _: &Client,
        control: &ZwlrGammaControlV1,
        request: zwlr_gamma_control_v1::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        match request {
            zwlr_gamma_control_v1::Request::SetGamma { fd } => state.gamma_set(control, fd),
            // `destroyed` lets go of the monitor, for a client that exits
            // without destroying it too.
            zwlr_gamma_control_v1::Request::Destroy => {}
            _ => unreachable!("version 1 has no other requests"),
        }
    }

    fn destroyed(state: &mut Self, _: ClientId, control: &ZwlrGammaControlV1, _: &()) {
        state.gamma_released(control);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write as _;

    #[test]
    fn a_ramp_is_read_whole_from_a_file() {
        let mut file = tempfile::tempfile().expect("a temporary file");
        file.write_all(&[1, 0, 2, 0, 3, 0]).expect("written");
        std::io::Seek::rewind(&mut file).expect("rewound");

        assert_eq!(read_ramp(file.into()).expect("read"), vec![1, 2, 3]);
    }

    #[test]
    fn an_empty_pipe_is_an_empty_ramp_rather_than_a_wait() {
        let (reader, _writer) = std::io::pipe().expect("a pipe");

        assert_eq!(read_ramp(reader.into()).expect("read"), Vec::<u16>::new());
    }
}
