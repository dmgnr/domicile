//! Tests for the layout a profile makes of the connected monitors.
//!
//! Unlike `desktop.rs`, sizes come from the monitors' modes, so one config
//! gives different layouts as monitors are plugged in. See
//! [docs/DISPLAYS.md](../../../docs/DISPLAYS.md#profiles).

use domicile_config::{
    Config, Connected, Desk, DisplayOverride, Layout, Transform, CONFIGURED_PROFILE,
};

/// The layout `text`'s profiles make of `connected`; panics if none.
fn layout(text: &str, connected: &[Connected]) -> Layout {
    Config::parse(text)
        .expect("the config should parse")
        .output
        .layout(connected)
        .expect("the layout should be representable")
        .expect("a profile should match")
}

/// A monitor with only an output name, as when it has no EDID.
fn connected(name: &str, mode: (u32, u32)) -> Connected {
    described(name, "", mode)
}

/// A monitor with an output name and an EDID description, but no `pnp.ids`
/// vendor name.
fn described(name: &str, description: &str, mode: (u32, u32)) -> Connected {
    spelled_out(name, description, "", mode)
}

/// A monitor with an output name, an EDID description, and the description
/// with the vendor name from `pnp.ids`.
fn spelled_out(name: &str, description: &str, spelled_out: &str, mode: (u32, u32)) -> Connected {
    Connected {
        name: name.to_owned(),
        description: description.to_owned(),
        spelled_out: spelled_out.to_owned(),
        connector: String::new(),
        mode,
        modes: Vec::new(),
    }
}

/// Output names for the laptop panel and the three desk monitors.
const LAPTOP: &str = "drm-1";
const LEFT: &str = "drm-2";
const CENTER: &str = "drm-3";
const RIGHT: &str = "drm-4";

/// 2880x1920 at scale 1.5 is 1920x1280 logical. 3840x2160 at 1.2 is
/// 3200x1800, or 1800x3200 rotated.
const PANEL_MODE: (u32, u32) = (2880, 1920);
const DESK_MODE: (u32, u32) = (3840, 2160);

#[test]
fn no_profiles_configured_is_no_layout() {
    // With no profiles, monitors stay where the engine put them.
    assert!(
        Config::parse("{}")
            .unwrap()
            .output
            .layout(&[connected(LAPTOP, PANEL_MODE)])
            .unwrap()
            .is_none(),
        "a config with no profiles places nothing"
    );
}

#[test]
fn a_profile_applies_only_to_the_exact_set_of_displays_it_names() {
    // A subset match would leave an extra monitor dark. An overlap match would
    // place windows on a missing monitor.
    //
    // The config has one profile so no other profile can catch the rejected
    // sets.
    let config = Config::parse(ONE_DESK).expect("the config should parse");
    let matched = |connected: &[Connected]| {
        config
            .output
            .layout(connected)
            .expect("the layout should be representable")
            .is_some()
    };
    assert!(
        matched(&[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)]),
        "the set the profile names is the set it applies to"
    );
    assert!(
        !matched(&[connected(LAPTOP, PANEL_MODE)]),
        "a display the profile names is not connected"
    );
    assert!(
        !matched(&[
            connected(LAPTOP, PANEL_MODE),
            connected(CENTER, DESK_MODE),
            connected(RIGHT, DESK_MODE),
        ]),
        "a display is connected that the profile does not name"
    );
}

#[test]
fn a_profile_can_name_a_monitor_by_its_panel_rather_than_its_output() {
    // Output names can't be predicted by looking at the hardware. The panel
    // name can, and kanshi and sway match on it too.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "desk",
        "displays": [
          {
            "display": "DEL DELL U3219Q G3MS413",
            "scale": 1.2,
            "transform": "rotate-270"
          }
        ]
      }
    ]
  }
}
"#,
        &[described(CENTER, "DEL DELL U3219Q G3MS413", DESK_MODE)],
    );
    let placed = layout
        .placed()
        .next()
        .expect("the monitor should be placed");
    assert_eq!(
        placed.name, CENTER,
        "the output keeps the name its clients are on; the panel's name is how it was found"
    );
    assert_eq!(placed.logical, (1800, 3200));
}

#[test]
fn a_profile_may_name_a_monitor_by_the_vendor_spelled_out() {
    // sway and kanshi print the vendor from hwdata's `pnp.ids` (`Dell Inc.`
    // for `DEL`), so configs copied from them use this form.
    assert!(
        the_desk_profile_matches("Dell Inc. DELL U3219Q G3MS413"),
        "a profile naming the vendor the way hwdata spells it should match"
    );
}

#[test]
fn a_profile_written_before_the_vendor_was_spelled_out_goes_on_matching() {
    // Existing configs use the three-letter vendor id, so it must keep
    // matching.
    assert!(
        the_desk_profile_matches("DEL DELL U3219Q G3MS413"),
        "the three letters an EDID states are still one of the names it answers to"
    );
}

/// Whether a profile naming `display` matches a monitor with both vendor
/// spellings.
fn the_desk_profile_matches(display: &str) -> bool {
    Config::parse(&format!(
        r#"
{{
  "output": {{
    "profiles": [{{ "name": "desk", "displays": [{{ "display": "{display}" }}] }}]
  }}
}}
"#
    ))
    .expect("the config should parse")
    .output
    .layout(&[spelled_out(
        CENTER,
        "DEL DELL U3219Q G3MS413",
        "Dell Inc. DELL U3219Q G3MS413",
        DESK_MODE,
    )])
    .expect("the layout should be representable")
    .is_some()
}

#[test]
fn a_scale_of_exactly_one_may_be_written_as_an_integer() {
    // `"scale": 1` is the most common value. Checks that serde accepts an
    // integer for the `f64`.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "desk",
        "displays": [{ "display": "drm-3", "scale": 1 }]
      }
    ]
  }
}
"#,
        &[connected(CENTER, DESK_MODE)],
    );
    assert_eq!(
        layout
            .placed()
            .next()
            .expect("the monitor should be placed")
            .logical,
        DESK_MODE,
        "scale 1 is the mode itself"
    );
}

#[test]
fn a_profile_can_name_a_monitor_by_its_connector() {
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      { "name": "desk", "displays": [{ "display": "DP-3", "scale": 2 }] }
    ]
  }
}
"#,
        &[Connected {
            connector: "DP-3".to_owned(),
            ..described(CENTER, "DEL DELL U3219Q G3MS413", DESK_MODE)
        }],
    );
    assert_eq!(
        layout
            .placed()
            .map(|placed| placed.name.as_str())
            .collect::<Vec<_>>(),
        vec![CENTER]
    );
}

#[test]
fn a_profile_may_name_some_monitors_by_panel_and_others_by_output() {
    // A laptop panel with no EDID name can only be named by its output.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "half-named",
        "displays": [
          {
            "display": "DEL DELL U3219Q G3MS413",
            "position": [0, 0],
            "scale": 1.2
          },
          { "display": "drm-1", "position": [640, 1800], "scale": 1.5 }
        ]
      }
    ]
  }
}
"#,
        &[
            described(CENTER, "DEL DELL U3219Q G3MS413", DESK_MODE),
            connected(LAPTOP, PANEL_MODE),
        ],
    );
    assert_eq!(
        layout.placed().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        vec![CENTER, LAPTOP]
    );
    assert_eq!(layout.size(), (3200, 3080));
}

#[test]
fn two_entries_naming_one_monitor_two_ways_is_not_a_match() {
    // Both entries resolve to one monitor. Counting entries alone would call
    // this a match and leave the other monitor dark.
    let config = Config::parse(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "twice-over",
        "displays": [
          { "display": "drm-3" },
          { "display": "DEL DELL U3219Q G3MS413" }
        ]
      }
    ]
  }
}
"#,
    )
    .expect("the config should parse");
    assert!(
        config
            .output
            .layout(&[
                described(CENTER, "DEL DELL U3219Q G3MS413", DESK_MODE),
                connected(LAPTOP, PANEL_MODE),
            ])
            .expect("a profile that does not match cannot fail to apply")
            .is_none(),
        "two entries resolving to one monitor leaves the other unnamed"
    );
}

#[test]
fn a_monitor_that_reports_no_panel_name_is_not_matched_by_an_empty_one() {
    // Displays with no EDID name share an empty description, so it must not
    // act as an identity. The config refuses an empty `display`.
    let config = Config::parse(
        r#"
{
  "output": {
    "profiles": [{ "name": "anon", "displays": [{ "display": "drm-1" }] }]
  }
}
"#,
    )
    .expect("the config should parse");
    assert!(
        config
            .output
            .layout(&[connected(LAPTOP, PANEL_MODE)])
            .expect("applicable")
            .is_some(),
        "a monitor with no panel name is still matched by its output name"
    );
}

#[test]
fn the_first_profile_that_matches_is_the_one_that_applies() {
    // Two profiles may name the same monitors, e.g. "work" and "play"
    // arrangements. Config order breaks the tie.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      { "name": "first", "displays": [{ "display": "drm-1" }] },
      { "name": "second", "displays": [{ "display": "drm-1" }] }
    ]
  }
}
"#,
        &[connected(LAPTOP, PANEL_MODE)],
    );
    assert_eq!(layout.profile(), "first");
}

#[test]
fn a_scale_divides_the_mode_into_the_logical_size() {
    // Scales are fractional. Rounding 1.5 to 2 would shrink the desktop.
    let layout = layout(ONE_PANEL, &[connected(LAPTOP, PANEL_MODE)]);
    let placed = layout.placed().next().expect("the panel should be placed");
    assert_eq!(placed.logical, (1920, 1280));
    assert_eq!(placed.mode, PANEL_MODE, "the panel's own mode is carried");
    assert_eq!(placed.scale, 1.5);
}

#[test]
fn a_quarter_turn_swaps_a_displays_axes() {
    // The mode is what the connector scans out, so it does not rotate. The
    // logical size is what the desktop is laid out in, so it does.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "sideways",
        "displays": [
          {
            "display": "drm-3",
            "scale": 1.2,
            "transform": "rotate-270"
          }
        ]
      }
    ]
  }
}
"#,
        &[connected(CENTER, DESK_MODE)],
    );
    let placed = layout
        .placed()
        .next()
        .expect("the monitor should be placed");
    assert_eq!(placed.logical, (1800, 3200));
    assert_eq!(
        placed.mode, DESK_MODE,
        "the connector still scans out 3840x2160"
    );
    assert_eq!(placed.transform, Transform::Rotate270);
    assert_eq!(layout.size(), (1800, 3200));
}

#[test]
fn a_disabled_display_has_to_be_connected_and_is_not_on_the_desktop() {
    // The profile names the closed laptop panel so it matches when all four
    // monitors are connected. Disabling it keeps windows off the panel.
    let layout = layout(
        HOME_OFFICE_FULL,
        &[
            connected(LAPTOP, PANEL_MODE),
            connected(LEFT, DESK_MODE),
            connected(CENTER, DESK_MODE),
            connected(RIGHT, DESK_MODE),
        ],
    );
    assert_eq!(
        layout.placed().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        vec![LEFT, CENTER, RIGHT],
        "the disabled panel is matched on and then left off"
    );
    // Each rotated monitor is 1800 wide.
    assert_eq!(
        layout.placed().map(|p| p.position).collect::<Vec<_>>(),
        vec![(0, 0), (1800, 0), (3600, 0)]
    );
    assert_eq!(layout.size(), (5400, 3200));
}

#[test]
fn a_disabled_display_is_a_connector_to_leave_dark() {
    // `placed` drops a disabled display, so `scanout` must report it. The
    // engine otherwise lights every connector that reports a mode.
    let layout = layout(
        HOME_OFFICE_FULL,
        &[
            connected(LAPTOP, PANEL_MODE),
            connected(LEFT, DESK_MODE),
            connected(CENTER, DESK_MODE),
            connected(RIGHT, DESK_MODE),
        ],
    );
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.name.as_str(), display.enabled, display.origin))
            .collect::<Vec<_>>(),
        vec![
            // The engine's display list includes dark connectors, so this one
            // gets an origin past the lit ones to avoid overlapping them.
            (LAPTOP, false, (11520, 0)),
            (LEFT, true, (0, 0)),
            (CENTER, true, (3840, 0)),
            (RIGHT, true, (7680, 0)),
        ],
        "the three lit ones are stepped across by the mode each of them scans \
         out, and the dark one is put past the end of them"
    );
}

#[test]
fn a_connector_says_where_the_profile_placed_it() {
    // The engine lays CRTCs out in a row. Pointer crossing needs the
    // profile's placement, which a dark connector lacks.
    let layout = layout(
        HOME_OFFICE_FULL,
        &[
            connected(LAPTOP, PANEL_MODE),
            connected(LEFT, DESK_MODE),
            connected(CENTER, DESK_MODE),
            connected(RIGHT, DESK_MODE),
        ],
    );
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.name.as_str(), display.desk))
            .collect::<Vec<_>>(),
        vec![
            (LAPTOP, None),
            (
                LEFT,
                Some(Desk {
                    position: (0, 0),
                    size: (1800, 3200)
                })
            ),
            (
                CENTER,
                Some(Desk {
                    position: (1800, 0),
                    size: (1800, 3200)
                })
            ),
            (
                RIGHT,
                Some(Desk {
                    position: (3600, 0),
                    size: (1800, 3200)
                })
            ),
        ]
    );
}

#[test]
fn a_connector_carries_the_turn_and_scale_its_window_is_drawn_at() {
    // The engine rotates and scales each monitor's page, and the shell only
    // sees logical pixels, so `scanout` carries both. A dark connector keeps
    // its entry's values.
    let layout = layout(
        HOME_OFFICE_FULL,
        &[
            connected(LAPTOP, PANEL_MODE),
            connected(LEFT, DESK_MODE),
            connected(CENTER, DESK_MODE),
            connected(RIGHT, DESK_MODE),
        ],
    );
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.name.as_str(), display.transform, display.scale))
            .collect::<Vec<_>>(),
        vec![
            (LAPTOP, Transform::Normal, 1.0),
            (LEFT, Transform::Rotate270, 1.2),
            (CENTER, Transform::Rotate270, 1.2),
            (RIGHT, Transform::Rotate270, 1.2),
        ]
    );
}

#[test]
fn the_connectors_are_stepped_across_in_the_order_the_profile_places_them() {
    // Connectors follow left-to-right placement, not config or connector
    // order. Connector order would send the pointer to the wrong screen.
    //
    // Steps use the mode, since that is what a connector occupies on the
    // engine's desktop.
    let layout = layout(
        CROSSED_DESK,
        &[connected(LEFT, DESK_MODE), connected(CENTER, PANEL_MODE)],
    );
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.name.as_str(), display.origin))
            .collect::<Vec<_>>(),
        vec![(LEFT, (2880, 0)), (CENTER, (0, 0))],
        "written first and placed second: the monitor the profile puts on the \
         left takes the origin, and the one beside it starts where that one's \
         mode ends"
    );
}

#[test]
fn a_layout_is_placed_about_its_own_top_left_corner() {
    // Profiles may use negative positions, but the chrome's desktop starts at
    // zero. `Desktop` normalizes the same way.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "above-and-left",
        "displays": [
          {
            "display": "drm-1",
            "position": [-1920, -1080],
            "scale": 1.5
          },
          { "display": "drm-3", "position": [0, 0], "scale": 1.2 }
        ]
      }
    ]
  }
}
"#,
        &[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)],
    );
    assert_eq!(
        layout.placed().map(|p| p.position).collect::<Vec<_>>(),
        vec![(0, 0), (1920, 1080)]
    );
    // 1920 + 3200 across, 1080 + 1800 down.
    assert_eq!(layout.size(), (5120, 2880));
}

#[test]
fn a_gap_between_two_placed_displays_is_part_of_the_desktop() {
    // The page spans gaps, as for a described desktop.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "apart",
        "displays": [
          { "display": "drm-1", "position": [0, 0], "scale": 1.5 },
          { "display": "drm-3", "position": [4000, 0], "scale": 1.2 }
        ]
      }
    ]
  }
}
"#,
        &[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)],
    );
    assert_eq!(layout.size(), (7200, 1800));
}

#[test]
fn a_display_without_a_position_goes_right_of_the_positioned_ones() {
    // An entry can set only its scale. Each one without a position starts at
    // the right edge of everything placed so far, in profile order, level
    // with the top of the positioned displays. Widths are logical, after
    // scale and rotation.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "scaled-only",
        "displays": [
          { "display": "drm-1", "scale": 1.5 },
          { "display": "drm-3", "position": [0, -500], "scale": 1.2 },
          { "display": "drm-4", "scale": 1.2, "transform": "rotate-270" }
        ]
      }
    ]
  }
}
"#,
        &[
            connected(LAPTOP, PANEL_MODE),
            connected(CENTER, DESK_MODE),
            connected(RIGHT, DESK_MODE),
        ],
    );
    assert_eq!(
        layout
            .placed()
            .map(|p| (p.name.as_str(), p.position))
            .collect::<Vec<_>>(),
        vec![(LAPTOP, (3200, 0)), (CENTER, (0, 0)), (RIGHT, (5120, 0))]
    );
    // 3200 + 1920 + 1800 across; the rotated monitor is 3200 tall.
    assert_eq!(layout.size(), (6920, 3200));
}

#[test]
fn displays_without_positions_make_a_row_from_the_origin() {
    // With nothing positioned there is no edge to start from.
    let layout = layout(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "unplaced",
        "displays": [
          { "display": "drm-1", "scale": 1.5 },
          { "display": "drm-3", "scale": 1.2 }
        ]
      }
    ]
  }
}
"#,
        &[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)],
    );
    assert_eq!(
        layout.placed().map(|p| p.position).collect::<Vec<_>>(),
        vec![(0, 0), (1920, 0)]
    );
}

#[test]
fn a_display_with_no_room_right_of_the_positioned_ones_is_refused() {
    // The positioned display ends past the last coordinate, so the next one
    // has nowhere to start.
    let refused = Config::parse(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "crowded",
        "displays": [
          { "display": "drm-3", "position": [2147483000, 0] },
          { "display": "drm-1" }
        ]
      }
    ]
  }
}
"#,
    )
    .expect("the config should parse")
    .output
    .layout(&[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)])
    .expect_err("a display that cannot start anywhere is refused");
    let said = refused.to_string();
    assert!(
        said.contains("crowded") && said.contains("drm-1"),
        "the complaint should name the profile and the display: {said}"
    );
}

#[test]
fn a_layout_that_does_not_fit_the_coordinate_space_is_refused_rather_than_wrapped() {
    // Sizes come from the hardware, so parsing can't catch this. It returns an
    // error, not a panic, so the compositor keeps its current desktop.
    let refused = Config::parse(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "unreachable",
        "displays": [
          { "display": "drm-1", "position": [0, 0] },
          { "display": "drm-3", "position": [2147483647, 0] }
        ]
      }
    ]
  }
}
"#,
    )
    .expect("the config should parse")
    .output
    .layout(&[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)])
    .expect_err("a desktop no coordinate can describe is refused");
    let said = refused.to_string();
    assert!(
        said.contains("unreachable") && said.contains("drm-3"),
        "the complaint should name the profile and the display: {said}"
    );
}

#[test]
fn rejects_a_profile_that_would_leave_the_desktop_empty() {
    // With every display disabled, windows have nowhere to go. Refused at
    // parse time rather than on hotplug.
    let err = Config::parse(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "lid-shut",
        "displays": [{ "display": "drm-1", "enabled": false }]
      }
    ]
  }
}
"#,
    )
    .expect_err("a profile that enables nothing is refused");
    assert!(
        err.to_string().contains("lid-shut"),
        "the complaint should name the profile: {err}"
    );
}

#[test]
fn rejects_a_profile_that_cannot_be_applied_as_written() {
    // Valid JSON that describes no usable layout, refused at parse time.
    for text in [
        // No displays: `DrmScreen` never reports zero monitors.
        r#"
{ "output": { "profiles": [{ "name": "empty", "displays": [] }] } }
"#,
        // Two entries for one display.
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "twice",
        "displays": [{ "display": "drm-1" }, { "display": "drm-1" }]
      }
    ]
  }
}
"#,
        // Duplicate profile names make the log ambiguous.
        r#"
{
  "output": {
    "profiles": [
      { "name": "desk", "displays": [{ "display": "drm-1" }] },
      { "name": "desk", "displays": [{ "display": "drm-3" }] }
    ]
  }
}
"#,
        // Empty profile name: the log line prints it.
        r#"
{
  "output": { "profiles": [{ "name": "", "displays": [{ "display": "drm-1" }] }] }
}
"#,
        // Empty display name never matches.
        r#"
{
  "output": { "profiles": [{ "name": "anon", "displays": [{ "display": "" }] }] }
}
"#,
        // Zero and negative scales.
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "flat",
        "displays": [{ "display": "drm-1", "scale": 0 }]
      }
    ]
  }
}
"#,
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "inside-out",
        "displays": [{ "display": "drm-1", "scale": -1.5 }]
      }
    ]
  }
}
"#,
        // Unknown transform.
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "sideways",
        "displays": [{ "display": "drm-1", "transform": "rotate-45" }]
      }
    ]
  }
}
"#,
        // A mode with a zero axis.
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "flattened",
        "displays": [{ "display": "drm-1", "mode": [3840, 0] }]
      }
    ]
  }
}
"#,
        // Unknown field, likely a typo.
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "typo",
        "displays": [{ "display": "drm-1", "scaale": 1.5 }]
      }
    ]
  }
}
"#,
    ] {
        assert!(
            Config::parse(text).is_err(),
            "should have been refused: {text}"
        );
    }
}

#[test]
fn a_scale_that_leaves_a_monitor_no_logical_pixels_is_refused() {
    // The maximum scale depends on the monitor's mode, so this is checked when
    // the layout is built. Clamping to one pixel would make an unusable screen.
    let refused = Config::parse(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "vanishing",
        "displays": [{ "display": "drm-1", "scale": 1e+308 }]
      }
    ]
  }
}
"#,
    )
    .expect("the config should parse")
    .output
    .layout(&[connected(LAPTOP, PANEL_MODE)])
    .expect_err("a display scaled out of existence is refused");
    let said = refused.to_string();
    assert!(
        said.contains("vanishing") && said.contains("drm-1"),
        "the complaint should name the profile and the display: {said}"
    );
}

#[test]
fn a_profile_may_state_the_mode_its_positions_were_written_for() {
    // An engine that reports no modes cannot set one, so there `mode` asserts
    // the monitor's mode.
    let stated = layout(LAPTOP_AT_ITS_MODE, &[connected(LAPTOP, PANEL_MODE)]);
    let unstated = layout(ONE_PANEL, &[connected(LAPTOP, PANEL_MODE)]);
    assert_eq!(
        (stated.placed().collect::<Vec<_>>(), stated.size()),
        (unstated.placed().collect::<Vec<_>>(), unstated.size()),
        "a mode the monitor is at changes nothing about where it goes"
    );
}

#[test]
fn a_monitor_that_is_not_at_the_mode_its_profile_states_is_refused() {
    // With no modes reported, the engine cannot set the one asked for, and
    // applying the profile at another would misplace the other displays.
    let refused = Config::parse(LAPTOP_AT_ITS_MODE)
        .expect("the config should parse")
        .output
        .layout(&[connected(LAPTOP, (1920, 1080))])
        .expect_err("a monitor at another mode should be refused");
    let said = refused.to_string();
    assert!(
        said.contains("laptop-only")
            && said.contains("drm-1")
            && said.contains("2880x1920")
            && said.contains("1920x1080"),
        "the complaint should name the profile, the display, the mode it \
         states and the mode that arrived: {said}"
    );
}

#[test]
fn a_dark_monitor_is_held_to_the_mode_its_profile_states_too() {
    // The connector row steps across dark monitors' modes too, so a wrong mode
    // misplaces them.
    let refused = Config::parse(
        r#"
{
  "output": {
    "profiles": [
      {
        "name": "lid-shut",
        "displays": [
          { "display": "drm-1", "enabled": false, "mode": [2880, 1920] },
          { "display": "drm-3", "scale": 1.2 }
        ]
      }
    ]
  }
}
"#,
    )
    .expect("the config should parse")
    .output
    .layout(&[
        connected(LAPTOP, (1920, 1080)),
        connected(CENTER, DESK_MODE),
    ])
    .expect_err("a dark monitor at another mode should be refused");
    let said = refused.to_string();
    assert!(
        said.contains("lid-shut") && said.contains("drm-1"),
        "the complaint should name the profile and the dark display: {said}"
    );
}

#[test]
fn a_profile_is_matched_again_on_every_reading_of_the_monitors() {
    // Matching runs on every hotplug, so unplugging the monitor switches to
    // the laptop-only layout without a reload.
    let config = Config::parse(TWO_MONITORS).expect("the config should parse");
    let applied = |connected: &[Connected]| {
        config
            .output
            .layout(connected)
            .expect("the layout should be representable")
            .map(|layout| (layout.profile().to_owned(), layout.size()))
    };
    assert_eq!(
        applied(&[connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)]),
        Some(("home-office-center".to_owned(), (3200, 3080)))
    );
    assert_eq!(
        applied(&[connected(LAPTOP, PANEL_MODE)]),
        Some(("laptop-only".to_owned(), (1920, 1280)))
    );
}

/// A monitor that offers `modes` and is scanning out the first.
fn offering(name: &str, modes: &[(u32, u32)]) -> Connected {
    Connected {
        modes: modes.to_vec(),
        ..connected(name, modes[0])
    }
}

/// The modes the laptop panel offers: native first.
const PANEL_MODES: &[(u32, u32)] = &[PANEL_MODE, (1920, 1280), (1440, 960)];

#[test]
fn a_profile_asks_for_a_mode_the_monitor_offers() {
    // The engine sets the mode, so the layout is made at it: the logical size
    // comes from the mode asked for, not the one the monitor is at.
    let layout = layout(
        r#"{ "output": { "profiles": [{ "name": "big-text",
              "displays": [{ "display": "drm-1", "mode": [1920, 1280], "refresh": 59.94 }] }] } }"#,
        &[offering(LAPTOP, PANEL_MODES)],
    );
    let placed: Vec<_> = layout.placed().collect();
    assert_eq!(
        placed[0].mode,
        (1920, 1280),
        "it is placed at the mode asked for"
    );
    assert_eq!(placed[0].logical, (1920, 1280));
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.mode, display.refresh_mhz))
            .collect::<Vec<_>>(),
        vec![(Some((1920, 1280)), Some(59_940))],
        "the engine is asked for the mode and the rate, in mHz"
    );
}

#[test]
fn a_profile_that_asks_for_nothing_leaves_the_engine_to_choose() {
    let layout = layout(ONE_PANEL, &[offering(LAPTOP, PANEL_MODES)]);
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.mode, display.refresh_mhz))
            .collect::<Vec<_>>(),
        vec![(None, None)],
        "no mode and no rate means the native mode"
    );
}

#[test]
fn adaptive_sync_is_off_unless_a_profile_asks_for_it() {
    let asked = layout(
        r#"{ "output": { "profiles": [{ "name": "smooth",
              "displays": [{ "display": "drm-1", "adaptive_sync": true }] }] } }"#,
        &[offering(LAPTOP, PANEL_MODES)],
    );
    assert!(
        asked.scanout()[0].adaptive_sync,
        "the engine is asked for it"
    );
    let unasked = layout(ONE_PANEL, &[offering(LAPTOP, PANEL_MODES)]);
    assert!(!unasked.scanout()[0].adaptive_sync, "off by default");
}

#[test]
fn hdr_is_off_unless_a_profile_asks_for_it() {
    let asked = layout(
        r#"{ "output": { "profiles": [{ "name": "bright",
              "displays": [{ "display": "drm-1", "hdr": true, "sdr_white": 240 }] }] } }"#,
        &[offering(LAPTOP, PANEL_MODES)],
    );
    assert!(asked.scanout()[0].hdr, "the engine is asked for it");
    assert_eq!(asked.scanout()[0].sdr_white, 240);
    let unasked = layout(ONE_PANEL, &[offering(LAPTOP, PANEL_MODES)]);
    assert!(!unasked.scanout()[0].hdr, "off by default");
    assert_eq!(
        unasked.scanout()[0].sdr_white,
        domicile_config::DEFAULT_SDR_WHITE,
        "BT.2408's reference white"
    );
}

#[test]
fn an_sdr_white_outside_what_pq_encodes_is_refused() {
    for white in [0, 10_001] {
        let config = format!(
            r#"{{ "output": {{ "profiles": [{{ "name": "bright",
                  "displays": [{{ "display": "drm-1", "hdr": true, "sdr_white": {white} }}] }}] }} }}"#
        );
        let error = Config::parse(&config).expect_err("a white PQ cannot encode is refused");
        assert!(error.to_string().contains("sdr_white"), "{error}");
    }
}

#[test]
fn a_rate_alone_keeps_the_monitor_at_its_size() {
    let layout = layout(
        r#"{ "output": { "profiles": [{ "name": "fast",
              "displays": [{ "display": "drm-1", "refresh": 120 }] }] } }"#,
        &[offering(LAPTOP, PANEL_MODES)],
    );
    assert_eq!(
        layout.placed().next().map(|placed| placed.mode),
        Some(PANEL_MODE)
    );
    assert_eq!(layout.scanout()[0].mode, None);
    assert_eq!(layout.scanout()[0].refresh_mhz, Some(120_000));
}

#[test]
fn a_mode_the_monitor_does_not_offer_is_refused() {
    let refused = Config::parse(
        r#"{ "output": { "profiles": [{ "name": "too-wide",
              "displays": [{ "display": "drm-1", "mode": [3840, 2160] }] }] } }"#,
    )
    .expect("the config should parse")
    .output
    .layout(&[offering(LAPTOP, PANEL_MODES)])
    .expect_err("a mode the monitor does not offer should be refused");
    let said = refused.to_string();
    assert!(
        said.contains("too-wide")
            && said.contains("drm-1")
            && said.contains("3840x2160")
            && said.contains("2880x1920, 1920x1280, 1440x960"),
        "the complaint should name the profile, the display, the mode asked \
         for and the modes on offer: {said}"
    );
}

#[test]
fn a_dark_monitor_may_ask_for_a_mode_it_offers() {
    let layout = layout(
        r#"{ "output": { "profiles": [{ "name": "lid-shut", "displays": [
              { "display": "drm-1", "enabled": false, "mode": [1440, 960] },
              { "display": "drm-3" }] }] } }"#,
        &[offering(LAPTOP, PANEL_MODES), connected(CENTER, DESK_MODE)],
    );
    assert_eq!(
        layout
            .scanout()
            .iter()
            .map(|display| (display.name.as_str(), display.origin))
            .collect::<Vec<_>>(),
        vec![(LAPTOP, (3840, 0)), (CENTER, (0, 0))],
    );
}

#[test]
fn a_rate_that_is_no_rate_is_refused() {
    for refresh in ["0", "-60", "1e300"] {
        let text = format!(
            r#"{{ "output": {{ "profiles": [{{ "name": "p",
                  "displays": [{{ "display": "drm-1", "refresh": {refresh} }}] }}] }} }}"#
        );
        let refused = Config::parse(&text).expect_err("a refresh of {refresh} should be refused");
        assert!(
            refused.to_string().contains("refresh"),
            "the complaint should name the refresh: {refused}"
        );
    }
}

/// A single profile for the laptop and one monitor, with no fallback.
const ONE_DESK: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "home-office-center",
        "displays": [
          { "display": "drm-1", "position": [640, 1800], "scale": 1.5 },
          { "display": "drm-3", "position": [0, 0], "scale": 1.2 }
        ]
      }
    ]
  }
}
"#;

/// The laptop-only profile with its `mode` stated.
const LAPTOP_AT_ITS_MODE: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "laptop-only",
        "displays": [{ "display": "drm-1", "mode": [2880, 1920], "scale": 1.5 }]
      }
    ]
  }
}
"#;

/// The laptop panel alone, scaled.
const ONE_PANEL: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "laptop-only",
        "displays": [{ "display": "drm-1", "scale": 1.5 }]
      }
    ]
  }
}
"#;

/// The laptop plus one monitor, with a laptop-only fallback.
///
/// The panel is centered under the monitor: (3200 - 1920) / 2 = 640 across,
/// and 1800 (the monitor's logical height) down.
const TWO_MONITORS: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "home-office-center",
        "displays": [
          { "display": "drm-1", "position": [640, 1800], "scale": 1.5 },
          { "display": "drm-3", "position": [0, 0], "scale": 1.2 }
        ]
      },
      {
        "name": "laptop-only",
        "displays": [{ "display": "drm-1", "scale": 1.5 }]
      }
    ]
  }
}
"#;

/// The full desk: three monitors on their sides and the laptop panel dark.
const HOME_OFFICE_FULL: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "home-office-full",
        "displays": [
          { "display": "drm-1", "enabled": false },
          {
            "display": "drm-2",
            "position": [0, 0],
            "scale": 1.2,
            "transform": "rotate-270"
          },
          {
            "display": "drm-3",
            "position": [1800, 0],
            "scale": 1.2,
            "transform": "rotate-270"
          },
          {
            "display": "drm-4",
            "position": [3600, 0],
            "scale": 1.2,
            "transform": "rotate-270"
          }
        ]
      }
    ]
  }
}
"#;

/// Two monitors with the right-hand one listed first, so config order
/// differs from placement order.
const CROSSED_DESK: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "crossed-desk",
        "displays": [
          { "display": "drm-2", "position": [1920, 0], "scale": 1.2 },
          { "display": "drm-3", "position": [0, 0], "scale": 1.5 }
        ]
      }
    ]
  }
}
"#;

#[test]
fn an_override_changes_the_matching_profiles_display_and_leaves_the_rest() {
    let config = Config::parse(ONE_DESK).expect("the config should parse");
    let monitors = [connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)];
    let overridden = config
        .output
        .overridden(
            &monitors,
            &[DisplayOverride {
                display: CENTER.to_string(),
                scale: Some(2.0),
                ..DisplayOverride::default()
            }],
        )
        .expect("a valid change");
    let layout = overridden
        .layout(&monitors)
        .expect("representable")
        .expect("the profile still matches");

    assert_eq!(layout.profile(), "home-office-center");
    let scales: Vec<(String, f64)> = layout
        .placed()
        .map(|placed| (placed.name.clone(), placed.scale))
        .collect();
    assert_eq!(
        scales,
        vec![(LAPTOP.to_string(), 1.5), (CENTER.to_string(), 2.0)]
    );
}

#[test]
fn an_override_with_no_matching_profile_makes_one_of_every_monitor() {
    let monitors = [connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)];
    let overridden = Config::parse("{}")
        .expect("the config should parse")
        .output
        .overridden(
            &monitors,
            &[DisplayOverride {
                display: LAPTOP.to_string(),
                transform: Some(Transform::Rotate90),
                ..DisplayOverride::default()
            }],
        )
        .expect("a valid change");
    let layout = overridden
        .layout(&monitors)
        .expect("representable")
        .expect("the made profile matches");

    assert_eq!(layout.profile(), CONFIGURED_PROFILE);
    assert_eq!(layout.placed().count(), 2);
    let laptop = layout.placed().next().expect("the laptop first");
    assert_eq!(laptop.transform, Transform::Rotate90);
}

#[test]
fn an_override_for_an_unplugged_monitor_waits_and_turning_every_one_off_is_refused() {
    let config = Config::parse(ONE_DESK).expect("the config should parse");
    let monitors = [connected(LAPTOP, PANEL_MODE), connected(CENTER, DESK_MODE)];
    let unplugged = config
        .output
        .overridden(
            &monitors,
            &[DisplayOverride {
                display: "HDMI-A-9".to_string(),
                enabled: Some(false),
                ..DisplayOverride::default()
            }],
        )
        .expect("kept for when it is plugged in");
    assert_eq!(
        unplugged.layout(&monitors).unwrap(),
        config.output.layout(&monitors).unwrap()
    );

    let off = |display: &str| DisplayOverride {
        display: display.to_string(),
        enabled: Some(false),
        ..DisplayOverride::default()
    };
    assert!(config
        .output
        .overridden(&monitors, &[off(LAPTOP), off(CENTER)])
        .is_err());
}

#[test]
fn a_later_override_wins_field_by_field() {
    let first = DisplayOverride {
        display: LAPTOP.to_string(),
        scale: Some(2.0),
        hdr: Some(true),
        ..DisplayOverride::default()
    };
    let later = DisplayOverride {
        display: LAPTOP.to_string(),
        scale: Some(1.5),
        ..DisplayOverride::default()
    };

    let both = first.and_then(later);

    assert_eq!(both.scale, Some(1.5));
    assert_eq!(both.hdr, Some(true));
}
