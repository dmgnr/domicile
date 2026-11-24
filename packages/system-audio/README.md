# @domicile-desktop/system-audio

A shell's mixer: devices, streams, cards, volume, mute and level meters, read
from PulseAudio or PipeWire through `pactl` and `parec`.

- Runs them with `domicile.processes`' `spawn` and `run`, in the C
  locale. They must be on the compositor's `PATH`; the flake's wrapper adds
  PulseAudio's.
- Published to npm. Ships built JavaScript and `.d.ts` from `dist/`.

## Usage

```ts
import { soundServer } from "@domicile-desktop/system-audio/sound-server";

const server = soundServer(domicile);
const stop = server.watch((audio) => draw(audio));
await server.setVolume(audio.outputs[0].id, 0.5);
const meters = server.meters((levels) => drawLevels(levels));
meters.meter(new Map([[id, audio.meters.get(id)]]));
```

- `watch` holds `pactl -f json subscribe` open and reports the whole state on
  each settled burst of changes. Without a sound server it reports nothing,
  logs once and retries every 5 s.
- Requests resolve `Result<Asked, AudioError>`. They run one at a time; a
  volume overtaken by a later one for the same id is skipped
  (`Asked.Overtaken`).
- Volumes are kept between 0 and 1.5 (pavucontrol's maximum); NaN is refused.
  Ids not of the form `watch` reports are refused before `pactl` runs.
- Meters run one `parec` per id and report peaks 20 times a second. Metering a
  microphone records it: call `stop` when the meters are not shown.
- The library's own meters, other mixers' meters and PipeWire filter streams
  are left out of the stream lists.
- A filter device (e.g. speaker correction) lists what it passes through in
  `through` and reads as `muted` when any of it is. `setMuted(id, false)`
  reads the server and unmutes the whole chain; muting mutes only `id`.
  While locked, a muted filter stream in the chain stays muted (`locked`).
  Devices behind a filter are `filtered`: hide them from pickers.
- While the desktop is locked, only `watch`, and `setVolume` and `setMuted` on
  an output, work ([LOCK.md](/docs/LOCK.md)). Everything else fails with
  `locked`.

## Modules

| Module | What it is |
| --- | --- |
| `./sound-server` | `soundServer(domicile)` and its types. |
| `./audio` | `Audio` and its devices, streams, cards and `Meter`s. |
| `./audio-error` | `AudioError`: why a request was refused. |
| `./asked` | `Asked`: what became of a request. |

## React

`@domicile-desktop/system-audio/react`, for a shell on
[`@domicile-desktop/react`](../react/README.md):

- `useAudio()`: the devices and streams, `undefined` until `pactl` answers.
- `useHasSoundCard()`: whether `/sys` lists a sound card, looked at every
  10s.
- `deskSound(domicile)`: the shared `audio` watch and the `sound` requests,
  one per desktop. Its `meters` are shared among open mixers by id
  (`sharedMeters`), so a device shown twice is recorded once.
- `deskSoundHardware(domicile)`: the watch behind `useHasSoundCard`.

## Test

```sh
bun run turbo test --filter @domicile-desktop/system-audio
```

Unit tests read recorded `pactl -f json` output (`src/pactl.fixture.ts`)
through fake `processes` (`src/system.fixture.ts`).
