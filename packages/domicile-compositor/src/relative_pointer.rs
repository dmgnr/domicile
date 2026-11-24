//! `zwp_relative_pointer_v1`: how far the pointer moved, for games and VM
//! viewers that turn a camera or drive a guest's mouse with it.
//!
//! The engine owns input, so the deltas come from the chrome on
//! [`ChromeMessage::PointerRelative`](domicile_protocol::ChromeMessage::PointerRelative),
//! after the motion that took the pointer there, accelerated and not.

use smithay::delegate_relative_pointer;
use smithay::input::pointer::RelativeMotionEvent;

use crate::DomicileCompositor;

impl DomicileCompositor {
    /// The pointer over `app_id` moved by `delta`, in its surface-local units,
    /// and by `delta_unaccel` before pointer acceleration.
    ///
    /// Dropped unless the pointer is over that app: a delta for an app it has
    /// left would reach whatever it is over now.
    pub(crate) fn move_relatively(
        &mut self,
        app_id: &str,
        delta: (f64, f64),
        delta_unaccel: (f64, f64),
    ) {
        if self.pointer_app.as_deref() != Some(app_id) {
            tracing::debug!(%app_id, "relative motion off the app under the pointer -> dropped");
            return;
        }
        let Some(surface) = self.pointer_surface.clone() else {
            return;
        };
        let pointer = self.seat.get_pointer().unwrap();
        let utime = self.start.elapsed().as_micros() as u64;
        pointer.relative_motion(
            self,
            Some((surface, (0.0, 0.0).into())),
            &RelativeMotionEvent {
                delta: delta.into(),
                delta_unaccel: delta_unaccel.into(),
                utime,
            },
        );
        pointer.frame(self);
    }
}

delegate_relative_pointer!(DomicileCompositor);
