//! Touch points on a native window: `wl_touch` for a client that reads it, the
//! pointer for one that does not.
//!
//! A sequence belongs to the chrome connection that began it and to one
//! window, as a pinch does (see [`crate::pinch`]). It ends canceled when that
//! window closes, the connection drops, the desk locks or input is captured.

use std::collections::HashMap;

use domicile_protocol::touch::Touch;
use smithay::backend::input::TouchSlot;
use smithay::input::touch::{DownEvent, MotionEvent, UpEvent};
use smithay::reexports::wayland_server::backend::ClientId;
use smithay::reexports::wayland_server::protocol::{
    wl_seat, wl_seat::WlSeat, wl_surface::WlSurface, wl_touch::WlTouch,
};
use smithay::reexports::wayland_server::{
    Client, DataInit, Dispatch, DisplayHandle, Resource as _,
};
use smithay::utils::SERIAL_COUNTER;
use smithay::wayland::compositor::with_states;
use smithay::wayland::seat::{SeatUserData, TouchUserData};

use crate::client_requests::ClientRequest;
use crate::surface_commit::window_geometry;
use crate::DomicileCompositor;

/// `BTN_LEFT`: a finger is the primary button to a client with no touch.
const BTN_LEFT: u32 = 0x110;

pub struct ActiveTouches {
    owner: usize,
    app_id: String,
    /// The points down, in the order they came, each where it last was on
    /// the surface.
    points: Vec<(i32, (f64, f64))>,
    /// Whether the client reads `wl_touch`. Fixed for the sequence, so a
    /// client that binds touch halfway through is not sent an up it never
    /// had the down for.
    native: bool,
    /// The time of the last event, in milliseconds.
    time: u32,
    /// The point that drives the pointer for a client without touch: the
    /// first one down, until it lifts.
    pointer: Option<i32>,
}

/// The clients with a `wl_touch`, and how many each holds.
#[derive(Default)]
pub struct TouchClients(HashMap<ClientId, usize>);

impl TouchClients {
    fn bound(&mut self, client: ClientId) {
        *self.0.entry(client).or_default() += 1;
    }

    fn released(&mut self, client: &ClientId) {
        if let Some(count) = self.0.get_mut(client) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.0.remove(client);
            }
        }
    }

    pub fn reads_touch(&self, client: &ClientId) -> bool {
        self.0.contains_key(client)
    }
}

/// `wl_touch`'s ids are a client's `i32`s and Smithay's slots `u32`s; the bits
/// pass through unchanged either way.
fn slot(id: i32) -> TouchSlot {
    TouchSlot::from(Some(u32::from_ne_bytes(id.to_ne_bytes())))
}

/// The chrome's box is the window geometry, not the surface; see pointer
/// motion.
fn surface_point(surface: &WlSurface, at: (f64, f64)) -> (f64, f64) {
    crate::window_geometry::surface_point(with_states(surface, window_geometry), at)
}

impl DomicileCompositor {
    pub fn forward_touch(&mut self, owner: usize, app_id: &str, touch: Touch) {
        match touch {
            Touch::Down { id, time, x, y } => self.touch_down(owner, app_id, id, time, (x, y)),
            Touch::Motion { id, time, x, y } => {
                if !self.owns_point(owner, app_id, id) {
                    return;
                }
                let Some((native, pointer)) = self
                    .touches
                    .as_ref()
                    .map(|active| (active.native, active.pointer))
                else {
                    return;
                };
                if native {
                    let Some(surface) = self.surface_for(app_id) else {
                        return;
                    };
                    let location = surface_point(&surface, (x, y));
                    self.moved_to(id, time, location);
                    let handle = self.seat.get_touch().unwrap();
                    handle.motion(
                        self,
                        Some((surface, (0.0, 0.0).into())),
                        &MotionEvent {
                            slot: slot(id),
                            location: location.into(),
                            time,
                        },
                    );
                    handle.frame(self);
                } else if pointer == Some(id) {
                    self.handle_client_request(ClientRequest::PointerMotion {
                        app_id: app_id.to_owned(),
                        x,
                        y,
                        moved: true,
                    });
                }
            }
            Touch::Up { id, time } => {
                if !self.owns_point(owner, app_id, id) {
                    return;
                }
                let Some(active) = self.touches.as_mut() else {
                    return;
                };
                active.points.retain(|(down, _)| *down != id);
                let native = active.native;
                let drove_the_pointer = active.pointer == Some(id);
                if drove_the_pointer {
                    active.pointer = None;
                }
                if active.points.is_empty() {
                    self.touches = None;
                }
                if native {
                    let handle = self.seat.get_touch().unwrap();
                    handle.up(
                        self,
                        &UpEvent {
                            slot: slot(id),
                            serial: SERIAL_COUNTER.next_serial(),
                            time,
                        },
                    );
                    handle.frame(self);
                } else if drove_the_pointer {
                    self.release_the_finger_button();
                }
            }
            Touch::Cancel { .. } => {
                if self
                    .touches
                    .as_ref()
                    .is_some_and(|active| active.owner == owner && active.app_id == app_id)
                {
                    self.cancel_touches();
                }
            }
        }
    }

    fn touch_down(&mut self, owner: usize, app_id: &str, id: i32, time: u32, at: (f64, f64)) {
        // One window's fingers at a time: a finger on another window, or from
        // another chrome, ends the sequence before.
        if self
            .touches
            .as_ref()
            .is_some_and(|active| active.owner != owner || active.app_id != app_id)
        {
            self.cancel_touches();
        }
        let Some(surface) = self.surface_for(app_id) else {
            tracing::debug!(%app_id, "touch down: no surface");
            return;
        };
        let native = surface
            .client()
            .is_some_and(|client| self.touch_clients.reads_touch(&client.id()));
        // The subsurface under the finger takes the point, and its motion
        // after, as any compositor hit-tests a surface tree.
        let (target, origin) = self.input_origin(&surface, surface_point(&surface, at));
        let active = self.touches.get_or_insert_with(|| ActiveTouches {
            owner,
            app_id: app_id.to_owned(),
            points: Vec::new(),
            native,
            time,
            pointer: None,
        });
        if active.points.iter().any(|(down, _)| *down == id) {
            return;
        }
        let location = if active.native {
            surface_point(&surface, at)
        } else {
            at
        };
        active.points.push((id, location));
        active.time = time;
        if active.native {
            let handle = self.seat.get_touch().unwrap();
            handle.down(
                self,
                Some((target, origin.into())),
                &DownEvent {
                    slot: slot(id),
                    location: location.into(),
                    serial: SERIAL_COUNTER.next_serial(),
                    time,
                },
            );
            handle.frame(self);
        } else if active.pointer.is_none() {
            // A client with no touch gets the first finger as the pointer and
            // its primary button, as Weston and Mutter emulate it.
            active.pointer = Some(id);
            self.handle_client_request(ClientRequest::PointerMotion {
                app_id: app_id.to_owned(),
                x: at.0,
                y: at.1,
                moved: true,
            });
            self.handle_client_request(ClientRequest::PointerButton {
                button: BTN_LEFT,
                pressed: true,
            });
        }
    }

    fn owns_point(&self, owner: usize, app_id: &str, id: i32) -> bool {
        self.touches.as_ref().is_some_and(|active| {
            active.owner == owner
                && active.app_id == app_id
                && active.points.iter().any(|(down, _)| *down == id)
        })
    }

    fn moved_to(&mut self, id: i32, time: u32, location: (f64, f64)) {
        let Some(active) = self.touches.as_mut() else {
            return;
        };
        active.time = time;
        if let Some(point) = active.points.iter_mut().find(|(down, _)| *down == id) {
            point.1 = location;
        }
    }

    fn release_the_finger_button(&mut self) {
        self.handle_client_request(ClientRequest::PointerButton {
            button: BTN_LEFT,
            pressed: false,
        });
    }

    pub fn cancel_touches(&mut self) {
        let Some(active) = self.touches.take() else {
            return;
        };
        if active.native {
            let handle = self.seat.get_touch().unwrap();
            let Some(surface) = self.surface_for(&active.app_id) else {
                // The window is gone, and with it the client's touch focus.
                handle.cancel(self);
                return;
            };
            // Smithay cancels only the points with an event since the last
            // frame, so each point is first told where it already is.
            for (id, location) in &active.points {
                handle.motion(
                    self,
                    Some((surface.clone(), (0.0, 0.0).into())),
                    &MotionEvent {
                        slot: slot(*id),
                        location: (*location).into(),
                        time: active.time,
                    },
                );
            }
            handle.cancel(self);
        } else if active.pointer.is_some() {
            self.release_the_finger_button();
        }
    }

    pub fn touch_owner_gone(&mut self, owner: usize) {
        if self
            .touches
            .as_ref()
            .is_some_and(|active| active.owner == owner)
        {
            self.cancel_touches();
        }
    }

    pub fn touch_window_gone(&mut self, app_id: &str) {
        if self
            .touches
            .as_ref()
            .is_some_and(|active| active.app_id == app_id)
        {
            self.cancel_touches();
        }
    }
}

/// Smithay's seat, with the `wl_touch`es each client takes counted, which
/// Smithay keeps to itself: a client without one gets the pointer instead.
/// Everything else is Smithay's own handling.
pub struct CountTouches;

impl Dispatch<WlSeat, SeatUserData<DomicileCompositor>, DomicileCompositor> for CountTouches {
    fn request(
        state: &mut DomicileCompositor,
        client: &Client,
        resource: &WlSeat,
        request: wl_seat::Request,
        data: &SeatUserData<DomicileCompositor>,
        dh: &DisplayHandle,
        data_init: &mut DataInit<'_, DomicileCompositor>,
    ) {
        if matches!(request, wl_seat::Request::GetTouch { .. }) {
            state.touch_clients.bound(client.id());
        }
        <smithay::input::SeatState<DomicileCompositor> as Dispatch<
            WlSeat,
            SeatUserData<DomicileCompositor>,
            DomicileCompositor,
        >>::request(state, client, resource, request, data, dh, data_init);
    }

    fn destroyed(
        state: &mut DomicileCompositor,
        client: ClientId,
        resource: &WlSeat,
        data: &SeatUserData<DomicileCompositor>,
    ) {
        <smithay::input::SeatState<DomicileCompositor> as Dispatch<
            WlSeat,
            SeatUserData<DomicileCompositor>,
            DomicileCompositor,
        >>::destroyed(state, client, resource, data);
    }
}

impl Dispatch<WlTouch, TouchUserData<DomicileCompositor>, DomicileCompositor> for CountTouches {
    fn request(
        state: &mut DomicileCompositor,
        client: &Client,
        resource: &WlTouch,
        request: <WlTouch as smithay::reexports::wayland_server::Resource>::Request,
        data: &TouchUserData<DomicileCompositor>,
        dh: &DisplayHandle,
        data_init: &mut DataInit<'_, DomicileCompositor>,
    ) {
        <smithay::input::SeatState<DomicileCompositor> as Dispatch<
            WlTouch,
            TouchUserData<DomicileCompositor>,
            DomicileCompositor,
        >>::request(state, client, resource, request, data, dh, data_init);
    }

    fn destroyed(
        state: &mut DomicileCompositor,
        client: ClientId,
        resource: &WlTouch,
        data: &TouchUserData<DomicileCompositor>,
    ) {
        state.touch_clients.released(&client);
        <smithay::input::SeatState<DomicileCompositor> as Dispatch<
            WlTouch,
            TouchUserData<DomicileCompositor>,
            DomicileCompositor,
        >>::destroyed(state, client, resource, data);
    }
}
