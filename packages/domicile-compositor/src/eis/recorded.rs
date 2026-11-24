//! EIS test fixtures: a compositor with one display and one window that
//! records what it was asked to inject, and a `reis` client.

use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, channel, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use domicile_config::Transform;
use domicile_scene::{Bounds, Point};
use reis::ei;
use reis::enumflags2::BitFlags;
use reis::event::{Connection, Device, EiEvent};
use smithay::reexports::calloop::EventLoop;

use super::{serve, Compositor, Desk, DeskInput, Eis, Window};
use crate::client_requests::ClientRequest;
use crate::screens::Advertised;

/// `a`, which this compositor's keyboard types with `KEY_A`.
pub const KEYSYM_A: u32 = 0x61;

/// How long [`in_the_background`] serves.
const SERVING: Duration = Duration::from_secs(30);

/// A compositor with one 1280x800 display at 2x, a window at 100,100 and
/// one against the right edge, which records what it is asked to inject.
#[derive(Default)]
pub struct Recorded {
    /// What was injected, unless it is sent to `forward`.
    pub injected: Vec<ClientRequest>,
    forward: Option<Sender<ClientRequest>>,
    /// Whether emulated input goes to the engine, as on a headless desk.
    pub engine_takes_input: bool,
    /// What went to the engine.
    pub engine_injected: Vec<DeskInput>,
}

impl Compositor for Recorded {
    fn desk(&self) -> Desk {
        Desk::new(
            vec![Advertised {
                name: "one".into(),
                position: (0, 0),
                logical: (1280, 800),
                mode: (2560, 1600),
                scale: 2.0,
                transform: Transform::Normal,
                description: String::new(),
                edid: String::new(),
                connector: String::new(),
                display: None,
                physical_mm: (0, 0),
                refresh_mhz: 0,
                adaptive_sync: crate::engine::AdaptiveSync::Unsupported,
                hdr: Default::default(),
            }],
            vec![
                Window {
                    app_id: "1".into(),
                    bounds: Bounds {
                        min: Point::new(100.0, 100.0),
                        max: Point::new(500.0, 400.0),
                    },
                    focused: true,
                },
                // Against the right edge.
                Window {
                    app_id: "2".into(),
                    bounds: Bounds {
                        min: Point::new(1000.0, 0.0),
                        max: Point::new(1280.0, 800.0),
                    },
                    focused: false,
                },
            ],
        )
    }

    fn inject(&mut self, request: ClientRequest) {
        match &self.forward {
            // The test may be done listening.
            Some(forward) => drop(forward.send(request)),
            None => self.injected.push(request),
        }
    }

    fn keycode(&self, keysym: u32) -> Option<u32> {
        (keysym == KEYSYM_A).then_some(30)
    }

    fn engine_takes_input(&self) -> bool {
        self.engine_takes_input
    }

    fn inject_into_the_engine(&mut self, input: DeskInput) {
        self.engine_injected.push(input);
    }
}

/// EIS served on a loop of its own thread for a while.
pub struct Background {
    pub eis: Eis,
    /// What it injected.
    pub injected: Receiver<ClientRequest>,
    /// Input to offer the captures, as the Wayland thread does.
    pub input: Sender<ClientRequest>,
}

pub fn in_the_background() -> Background {
    let (forward, injected) = channel();
    let (input, offered) = channel::<ClientRequest>();
    let (opened, eis) = channel();
    thread::spawn(move || {
        let mut event_loop = EventLoop::try_new().unwrap();
        let (eis, captures) = serve(&event_loop.handle()).unwrap();
        opened.send(eis).unwrap();
        let mut compositor = Recorded {
            forward: Some(forward),
            ..Recorded::default()
        };
        let started = Instant::now();
        while started.elapsed() < SERVING {
            event_loop
                .dispatch(Duration::from_millis(10), &mut compositor)
                .unwrap();
            for request in offered.try_iter() {
                if !captures.divert(&request, &compositor.desk()) {
                    compositor.inject(request);
                }
            }
        }
    });
    Background {
        eis: eis.recv().unwrap(),
        injected,
        input,
    }
}

/// A region as a client sees it: offset, size and scale.
pub type Region = (u32, u32, u32, u32, f32);

/// What a client thread reports.
#[derive(Debug, PartialEq)]
pub enum Saw {
    /// Its devices, by name, with each one's regions.
    Devices(Vec<(String, Vec<Region>)>),
    Disconnected,
}

/// A client on `socket` that binds everything, waits for `devices` devices,
/// reports them, then runs `act` with them.
pub fn a_client(
    socket: OwnedFd,
    devices: usize,
    act: impl FnOnce(&Connection, &[Device]) + Send + 'static,
) -> Receiver<Saw> {
    let (saw, seen) = mpsc::channel();
    thread::spawn(move || {
        let context = ei::Context::new(UnixStream::from(socket)).unwrap();
        let (connection, events) = context
            .handshake_blocking("domicile test", ei::handshake::ContextType::Sender)
            .unwrap();
        let mut resumed = Vec::new();
        let mut act = Some(act);
        for event in events {
            match event {
                Ok(EiEvent::SeatAdded(added)) => {
                    added.seat.bind_capabilities(BitFlags::all());
                    connection.flush().unwrap();
                }
                Ok(EiEvent::DeviceResumed(device)) => {
                    resumed.push(device.device);
                    if resumed.len() == devices {
                        saw.send(Saw::Devices(described(&resumed))).unwrap();
                        act.take().unwrap()(&connection, &resumed);
                        connection.flush().unwrap();
                    }
                }
                Ok(EiEvent::Disconnected(_)) => {
                    saw.send(Saw::Disconnected).unwrap();
                    return;
                }
                Ok(_) => {}
                Err(err) => panic!("the client heard {err}"),
            }
        }
    });
    seen
}

fn described(devices: &[Device]) -> Vec<(String, Vec<Region>)> {
    devices
        .iter()
        .map(|device| {
            (
                device.name().unwrap().to_owned(),
                device
                    .regions()
                    .iter()
                    .map(|region| {
                        (
                            region.x,
                            region.y,
                            region.width,
                            region.height,
                            region.scale,
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}

/// What a receiving client got.
#[derive(Debug, PartialEq)]
pub enum Got {
    /// This many devices resumed.
    Devices(usize),
    /// Its devices started emulating, under this sequence.
    Emulating(u32),
    Motion(f32, f32),
    Scroll(f32, f32),
    ScrollStop(bool, bool),
    Key(u32, bool),
}

/// An InputCapture client on `socket`: a receiver that binds everything and
/// reports what it gets once all its devices resumed.
pub fn a_receiver(socket: OwnedFd) -> Receiver<Got> {
    let (got, getting) = mpsc::channel();
    thread::spawn(move || {
        let context = ei::Context::new(UnixStream::from(socket)).unwrap();
        let (connection, events) = context
            .handshake_blocking("domicile test", ei::handshake::ContextType::Receiver)
            .unwrap();
        let mut resumed = 0;
        let mut emulating = false;
        for event in events {
            let report = match event.unwrap() {
                EiEvent::SeatAdded(added) => {
                    added.seat.bind_capabilities(BitFlags::all());
                    connection.flush().unwrap();
                    None
                }
                EiEvent::DeviceAdded(_) => None,
                EiEvent::DeviceResumed(_) => {
                    resumed += 1;
                    Some(Got::Devices(resumed))
                }
                EiEvent::DeviceStartEmulating(started) if !emulating => {
                    emulating = true;
                    Some(Got::Emulating(started.sequence))
                }
                EiEvent::PointerMotion(motion) => Some(Got::Motion(motion.dx, motion.dy)),
                EiEvent::ScrollDelta(scroll) => Some(Got::Scroll(scroll.dx, scroll.dy)),
                EiEvent::ScrollStop(stop) => Some(Got::ScrollStop(stop.x, stop.y)),
                EiEvent::KeyboardKey(key) => Some(Got::Key(
                    key.key,
                    key.state == ei::keyboard::KeyState::Press,
                )),
                EiEvent::Disconnected(_) => return,
                _ => None,
            };
            // Devices are reported once all of them resumed.
            if let Some(report) = report.filter(|report| !matches!(report, Got::Devices(1))) {
                if got.send(report).is_err() {
                    return;
                }
            }
        }
    });
    getting
}
