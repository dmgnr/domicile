# Monitors

Plug a monitor in and the desktop spreads onto it, to the right of the
others. To place, scale or rotate them, save a **profile**: an arrangement
for a set of monitors. When you plug in monitors, the first profile whose
monitors are all there is used.

<!-- tab: Settings app -->

Open **Settings**, then **Displays**, and **Add profile**. Add each monitor
to it by name, then set its scale, position and rotation, or switch it off.

<!-- tab: Config file -->

```json
{
  "output": {
    "profiles": [
      {
        "name": "desk",
        "displays": [
          { "display": "drm-1", "enabled": false },
          { "display": "DEL DELL U3219Q 2ZLS413", "scale": 1.5, "transform": "rotate-270" }
        ]
      },
      { "name": "laptop", "displays": [{ "display": "drm-1", "scale": 1.5 }] }
    ]
  }
}
```

- A monitor is named by its maker, model and serial number, as above, by the
  port it is plugged into, such as `DP-1`, or by its name on the desktop, such
  as `drm-1`.
- A monitor without a `position` goes to the right of the others.
- `rotate-270` is for a monitor turned a quarter to the left, `rotate-90` to
  the right.
- `"mode": [1920, 1080]` lights a monitor at another size it offers, and
  `"refresh": 120` at another rate, in Hz. Without them, it uses its own best
  size and rate.
- `"adaptive_sync": true` turns on variable refresh (FreeSync or G-Sync
  Compatible) on a monitor that supports it, which smooths out games and
  video when the computer can't keep up with the monitor.
- `"hdr": true` turns on HDR on a monitor that supports it, for brighter,
  richer HDR video and photos. If everything else looks too dim, raise
  `"sdr_white"` from its default of 203, for example to 250.

<!-- /tabs -->

To find your monitors' names, run `wayland-info` in a terminal on the
desktop: each `wl_output` lists its `name` and `description`.

Each monitor gets its own bar and shows its own workspace. Move windows
across with Meta+Shift+arrows, or drag them.

More: [DISPLAYS.md](../DISPLAYS.md).

## Night light

The night light warms the screens' color in the evening. Switch it from the
brightness item in the [top bar](TOP-BAR.md); it then holds until the next
change in its schedule.

<!-- tab: Settings app -->

Open **Settings**, then **Shell**. Set the night light's schedule (sunset to
sunrise, your own hours, or off) and its warmth. Automatic brightness, which
follows the room's light, is here too.

<!-- tab: Config file -->

```json
{
  "shell_options": {
    "nightLight": {
      "schedule": "custom",
      "from": "21:30",
      "to": "07:00",
      "warmth": 60
    }
  }
}
```

`nightLight.schedule` is `sunset to sunrise` (the default), `custom` or
`off`. `brightness.automatic` turns automatic brightness off with `false`.

<!-- /tabs -->

Apps such as gammastep and wl-gammarelay-rs can set each screen's color
themselves, so two screens can be warmed differently. While one of them sets
a screen, the night light leaves that screen alone.

## Cast to a TV

When a Chromecast, Google TV, Fire TV, Roku or other TV that takes a cast is
nearby, the **Cast** item shows in the [top bar](TOP-BAR.md). Click it, then
on the TV:

- **Extend** to use the TV as another monitor, above your screens: move
  the pointer up off the top to reach it, or
- **Show…** to show one window, monitor or area on it.

Sound goes with it. While casting, notifications don't pop up, and the
screens stay on. **Stop** is in the same place.

Apple TVs and AirPlay aren't supported. More:
[CASTING-TO-TVS.md](../CASTING-TO-TVS.md).
