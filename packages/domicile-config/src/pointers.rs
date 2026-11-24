//! Absolute pointing devices bound to one display each.
//!
//! On a tty the engine maps a tablet or touchscreen across one display it is
//! told about. Unbound, it has no display. See
//! `docs/DISPLAYS.md#tablets-and-touchscreens`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{ConfigError, Connected};

/// A tablet or touchscreen, and the display it covers.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PointerConfig {
    /// The device's evdev name or `phys`, matched exactly.
    ///
    /// A name every device of a kind shares, such as `QEMU QEMU USB Tablet`,
    /// binds all of them; `phys` (`usb-0000:00:04.0-1/input0`) tells them
    /// apart. `udevadm info /dev/input/eventN` prints both.
    pub device: String,
    /// The display the device covers, named as a profile's `display` is.
    pub display: String,
}

/// A pointer whose display is connected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointerTarget {
    /// [`PointerConfig::device`].
    pub device: String,
    /// The display's output name, whichever of its names the config wrote.
    pub display: String,
}

/// Each pointer whose display is connected, in config order.
///
/// A pointer whose display is unplugged is left out, so the engine leaves
/// that device unbound.
pub(crate) fn targets(pointers: &[PointerConfig], connected: &[Connected]) -> Vec<PointerTarget> {
    pointers
        .iter()
        .filter_map(|pointer| {
            connected
                .iter()
                .find(|display| display.is_named(&pointer.display))
                .map(|display| PointerTarget {
                    device: pointer.device.clone(),
                    display: display.name.clone(),
                })
        })
        .collect()
}

/// Refuses an entry that names nothing, and a device bound twice.
pub(crate) fn validate(pointers: &[PointerConfig]) -> Result<(), ConfigError> {
    for (index, pointer) in pointers.iter().enumerate() {
        let at = format!("input.pointers[{index}]");
        if pointer.device.trim().is_empty() {
            return Err(ConfigError::Validation(format!(
                "{at} must name a device by its evdev name or phys"
            )));
        }
        // The engine reads the name as a C string.
        if pointer.device.contains('\0') {
            return Err(ConfigError::Validation(format!(
                "{at} device {:?} holds a nul, which no device's name or phys does",
                pointer.device
            )));
        }
        if pointer.display.trim().is_empty() {
            return Err(ConfigError::Validation(format!(
                "{at} must name the display {} covers",
                pointer.device
            )));
        }
        if pointers[..index]
            .iter()
            .any(|earlier| earlier.device == pointer.device)
        {
            return Err(ConfigError::Validation(format!(
                "input.pointers binds {} twice, and a device covers one display",
                pointer.device
            )));
        }
    }
    Ok(())
}
