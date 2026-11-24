//! Tests for binding absolute pointing devices to displays.
//!
//! See [docs/DISPLAYS.md](../../../docs/DISPLAYS.md#tablets-and-touchscreens).

use domicile_config::{Config, ConfigError, Connected, PointerTarget};

/// The targets `text`'s pointers make on `connected`.
fn targets(text: &str, connected: &[Connected]) -> Vec<PointerTarget> {
    Config::parse(text)
        .expect("the config should parse")
        .input
        .pointer_targets(connected)
}

/// A monitor with an output name and an EDID description.
fn connected(name: &str, description: &str) -> Connected {
    Connected {
        name: name.to_owned(),
        description: description.to_owned(),
        spelled_out: String::new(),
        connector: String::new(),
        mode: (1920, 1080),
        modes: Vec::new(),
    }
}

fn target(device: &str, display: &str) -> PointerTarget {
    PointerTarget {
        device: device.to_owned(),
        display: display.to_owned(),
    }
}

#[test]
fn a_desk_that_binds_no_pointer_binds_none() {
    assert_eq!(targets("{}", &[connected("drm-1", "")]), vec![]);
}

#[test]
fn a_pointer_covers_the_display_it_names_by_any_of_its_names() {
    let text = r#"
{ "input": { "pointers": [
  { "device": "usb-0000:00:04.0-1/input0", "display": "Virtual-1" },
  { "device": "usb-0000:00:04.0-2/input0", "display": "RHT QEMU Monitor 2" }
] } }
"#;
    assert_eq!(
        targets(
            text,
            &[
                connected("Virtual-1", ""),
                connected("drm-2", "RHT QEMU Monitor 2"),
            ]
        ),
        // The output name, whichever name the config wrote.
        vec![
            target("usb-0000:00:04.0-1/input0", "Virtual-1"),
            target("usb-0000:00:04.0-2/input0", "drm-2"),
        ]
    );
}

#[test]
fn a_pointer_whose_display_is_unplugged_covers_nothing() {
    let text = r#"
{ "input": { "pointers": [
  { "device": "QEMU QEMU USB Tablet", "display": "Virtual-2" }
] } }
"#;
    assert_eq!(targets(text, &[connected("Virtual-1", "")]), vec![]);
}

#[test]
fn rejects_a_pointer_that_names_no_device_or_no_display() {
    for entry in [
        r#"{ "device": "", "display": "Virtual-1" }"#,
        r#"{ "device": "QEMU QEMU USB Tablet", "display": " " }"#,
    ] {
        let text = format!(r#"{{ "input": {{ "pointers": [{entry}] }} }}"#);
        let err = Config::parse(&text).unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "{entry}: {err:?}"
        );
    }
}

#[test]
fn rejects_a_device_with_a_nul_which_no_device_name_holds() {
    let err = Config::parse(
        r#"{ "input": { "pointers": [{ "device": "QEMU\u0000", "display": "Virtual-1" }] } }"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

#[test]
fn rejects_a_device_bound_to_two_displays() {
    let err = Config::parse(
        r#"
{ "input": { "pointers": [
  { "device": "QEMU QEMU USB Tablet", "display": "Virtual-1" },
  { "device": "QEMU QEMU USB Tablet", "display": "Virtual-2" }
] } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}
