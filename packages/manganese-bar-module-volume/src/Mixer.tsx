import { DrilldownPage } from "@domicile-desktop/component-library/Drilldown";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { List, ListRow } from "@domicile-desktop/component-library/ListRow";
import { PanelSection } from "@domicile-desktop/component-library/PanelSection";
import type { SelectOption } from "@domicile-desktop/component-library/Select";
import { Select } from "@domicile-desktop/component-library/Select";
import type {
  Audio,
  AudioCard,
  AudioDevice,
  AudioStream,
} from "@domicile-desktop/system-audio/audio";
import type { SoundControls } from "@domicile-desktop/system-audio/react";
import { BluetoothIcon } from "@phosphor-icons/react/dist/ssr/Bluetooth";
import { CaretRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { HeadphonesIcon } from "@phosphor-icons/react/dist/ssr/Headphones";
import { MicrophoneIcon } from "@phosphor-icons/react/dist/ssr/Microphone";
import { MonitorIcon } from "@phosphor-icons/react/dist/ssr/Monitor";
import { SpeakerHighIcon } from "@phosphor-icons/react/dist/ssr/SpeakerHigh";
import { SpeakerSlashIcon } from "@phosphor-icons/react/dist/ssr/SpeakerSlash";
import type { ReactNode } from "react";
import { useState } from "react";

import { css } from "../styled-system/css";
import { flex, hstack } from "../styled-system/patterns";
import { ask } from "./ask";
import type { Direction } from "./Level";
import { Level } from "./Level";
import { primary } from "./primary";
import { profileName } from "./profile-name";
import type { Route } from "./routes";
import { routesOf } from "./routes";
import { useMeters } from "./useMeters";

type Props = {
  audio: Audio;
  /** Where changes are requested and meters read. */
  server: SoundControls;
};

/** A page deeper in the mixer: an app's, by name, or the sound cards'. */
type Page = { app: string } | "cards";

/**
 * The full sound mixer, in the bar's panel; a replacement for pavucontrol.
 * Goes in a `Drilldown`, which shows its pages.
 *
 * Speakers and Microphone: a picker of where sound goes or comes from, as
 * people name them ("Speakers", "Headphones", "HDMI"), over the volume of the
 * one in use. Picking one switches the device and its port together. Only the
 * microphone is metered, so a person can see it hears them.
 *
 * Apps: each app playing or recording, with one volume for all of its sound.
 * Its page moves it to another device. Output monitors are hidden from the
 * microphones, as in pavucontrol, but an app can still record from one.
 *
 * Sound card modes, which rarely change, are on a page of their own.
 */
export const Mixer = ({ audio, server }: Props) => {
  const [page, setPage] = useState<Page | undefined>(undefined);
  const output = primary(audio.outputs);
  const input = primary(audio.inputs.filter((device) => !device.monitor));
  const apps = byApp(audio.playback, audio.recording);
  const levels = useMeters(
    server,
    input === undefined ? [] : [input.id],
    audio.meters,
  );
  const close = () => {
    setPage(undefined);
  };
  const shownApp =
    page === undefined || page === "cards"
      ? undefined
      : apps.find((app) => app.name === page.app);
  return (
    <div className={mainStyles}>
      {output === undefined && input === undefined && (
        <EmptyState
          // With a card, the way to sound may be its mode, turned off.
          hint={
            audio.cards.length === 0
              ? "Plug some in and they'll show up here."
              : undefined
          }
          icon={SpeakerSlashIcon}
          title="No speakers or microphones"
        />
      )}
      {output !== undefined && (
        <PanelSection label="Speakers">
          <Routes
            direction="output"
            routes={routesOf(audio.outputs)}
            server={server}
          />
          <DeviceLevel
            device={output}
            direction="output"
            label="Volume"
            meter={undefined}
            server={server}
          />
        </PanelSection>
      )}
      {input !== undefined && (
        <PanelSection label="Microphone">
          <Routes
            direction="input"
            routes={routesOf(audio.inputs)}
            server={server}
          />
          <DeviceLevel
            device={input}
            direction="input"
            label="Microphone"
            meter={levels.get(input.id)}
            server={server}
          />
        </PanelSection>
      )}
      {apps.length > 0 && (
        <PanelSection label="Apps">
          {apps.map((app) => (
            <AppRow
              app={app}
              key={app.name}
              onOpen={() => {
                setPage({ app: app.name });
              }}
              server={server}
            />
          ))}
        </PanelSection>
      )}
      {audio.cards.length > 0 && (
        <List>
          <ListRow
            end={<CaretRightIcon aria-hidden size={14} weight="bold" />}
            label="Sound card modes"
            onPress={() => {
              setPage("cards");
            }}
          />
        </List>
      )}
      {shownApp !== undefined && (
        <DrilldownPage onBack={close} title={shownApp.name}>
          <AppPage
            app={shownApp}
            inputs={audio.inputs}
            outputs={audio.outputs}
            server={server}
          />
        </DrilldownPage>
      )}
      {page === "cards" && (
        <DrilldownPage onBack={close} title="Sound card modes">
          <Cards cards={audio.cards} server={server} />
        </DrilldownPage>
      )}
    </div>
  );
};

/** An app and its playback and recording streams. */
type App = {
  name: string;
  playback: readonly AudioStream[];
  recording: readonly AudioStream[];
};

/** Streams grouped by app, in first-seen app order. */
const byApp = (
  playback: readonly AudioStream[],
  recording: readonly AudioStream[],
): readonly App[] =>
  [
    ...new Set([...playback, ...recording].map((stream) => stream.application)),
  ].map((name) => ({
    name,
    playback: playback.filter((stream) => stream.application === name),
    recording: recording.filter((stream) => stream.application === name),
  }));

type DeviceLevelProps = {
  device: AudioDevice;
  direction: Direction;
  server: SoundControls;
  /** The slider's label: its purpose, not the device name. */
  label: string;
  meter: number | undefined;
};

/** One of the two sliders, for the device in use. */
const DeviceLevel = ({
  device,
  direction,
  server,
  label,
  meter,
}: DeviceLevelProps) => (
  <Level
    direction={direction}
    label={label}
    level={device.volume}
    meter={meter}
    muted={device.muted}
    onLevel={(level) => {
      ask(server.setVolume(device.id, level));
    }}
    onMuted={(muted) => {
      ask(server.setMuted(device.id, muted));
    }}
  />
);

type RoutesProps = {
  direction: Direction;
  routes: readonly Route[];
  server: SoundControls;
};

/**
 * Where sound goes or comes from, as a picker showing the one in use. Absent
 * with nothing to pick between.
 */
const Routes = ({ direction, routes, server }: RoutesProps) => {
  const current = routes.find(({ picked }) => picked);
  return (
    routes.length > 1 && (
      <Select<string>
        aria-label={direction === "output" ? "Play sound on" : "Record from"}
        onValueChange={(key) => {
          const route = routes.find((each) => each.key === key);
          if (route !== undefined) {
            pick(route, server);
          }
        }}
        options={routes.map((route) => ({
          label: (
            <Choice
              detail={route.detail}
              icon={iconOf(route, direction)}
              label={route.label}
            />
          ),
          textLabel: route.label,
          value: route.key,
        }))}
        prefixIcon={
          current === undefined ? undefined : iconOf(current, direction)
        }
        size="sm"
        surface="filled"
        value={current?.key ?? null}
      />
    )
  );
};

/** Asks for the route's device and port, whichever aren't in use already. */
const pick = ({ device, port }: Route, server: SoundControls) => {
  if (!device.default) {
    ask(server.setDefault(device.id));
  }
  if (port !== undefined && port.name !== device.port) {
    ask(server.setPort(device.id, port.name));
  }
};

/** A picture of the route, guessed from its names. */
const iconOf = (route: Route, direction: Direction) => {
  const names = [route.label, route.port?.name ?? "", route.device.id]
    .join(" ")
    .toLowerCase();
  if (/bluez|bluetooth/.test(names)) {
    return <BluetoothIcon />;
  } else if (/head(phone|set)/.test(names)) {
    return <HeadphonesIcon />;
  } else if (/hdmi|displayport|monitor/.test(names)) {
    return <MonitorIcon />;
  } else if (direction === "input") {
    return <MicrophoneIcon />;
  } else {
    return <SpeakerHighIcon />;
  }
};

type ChoiceProps = {
  icon: ReactNode;
  label: string;
  /** Tells apart two choices with the same label, such as the card's name. */
  detail: string | undefined;
};

/** A route in the picker's list: its picture, its name and its detail. */
const Choice = ({ detail, icon, label }: ChoiceProps) => (
  <span className={choiceStyles}>
    <span aria-hidden className={choiceIconStyles}>
      {icon}
    </span>
    <span>
      {label}
      {detail !== undefined && (
        <span className={choiceDetailStyles}>{detail}</span>
      )}
    </span>
  </span>
);

type AppRowProps = {
  app: App;
  onOpen: () => void;
  server: SoundControls;
};

/**
 * An app, opening its page, over one volume for all of its sound: what it
 * plays, else what it records. The volume lines up with the device sliders.
 */
const AppRow = ({ app, onOpen, server }: AppRowProps) => (
  <div className={appStyles}>
    <List>
      <ListRow
        detail={app.recording.length > 0 ? "Using the microphone" : undefined}
        end={<CaretRightIcon aria-hidden size={14} weight="bold" />}
        label={app.name}
        onPress={onOpen}
      />
    </List>
    <Streams
      direction={app.playback.length > 0 ? "output" : "input"}
      label={app.name}
      server={server}
      streams={app.playback.length > 0 ? app.playback : app.recording}
    />
  </div>
);

type StreamsProps = {
  direction: Direction;
  label: string;
  server: SoundControls;
  /** At least one; the first one's volume is shown. */
  streams: readonly AudioStream[];
};

/** One volume for several streams, which move together. */
const Streams = ({ direction, label, server, streams }: StreamsProps) => {
  const [first] = streams;
  return (
    first !== undefined && (
      <Level
        direction={direction}
        label={label}
        level={first.volume}
        muted={first.muted}
        onLevel={(level) => {
          for (const stream of streams) {
            ask(server.setVolume(stream.id, level));
          }
        }}
        onMuted={(muted) => {
          for (const stream of streams) {
            ask(server.setMuted(stream.id, muted));
          }
        }}
      />
    )
  );
};

type AppPageProps = {
  app: App;
  server: SoundControls;
  /** Where a recording can go: every input, monitors included. */
  inputs: readonly AudioDevice[];
  /** Where a playback stream can go. */
  outputs: readonly AudioDevice[];
};

/** Where an app plays and records, each with its volume. */
const AppPage = ({ app, inputs, outputs, server }: AppPageProps) => (
  <>
    {app.playback.length > 0 && (
      <PanelSection label="Plays on">
        <StreamDevice
          devices={outputs}
          label="Plays on"
          server={server}
          streams={app.playback}
        />
        <Streams
          direction="output"
          label={`${app.name} playing`}
          server={server}
          streams={app.playback}
        />
      </PanelSection>
    )}
    {app.recording.length > 0 && (
      <PanelSection label="Records from">
        <StreamDevice
          devices={inputs}
          label="Records from"
          server={server}
          streams={app.recording}
        />
        <Streams
          direction="input"
          label={`${app.name} recording`}
          server={server}
          streams={app.recording}
        />
      </PanelSection>
    )}
  </>
);

type StreamDeviceProps = {
  devices: readonly AudioDevice[];
  label: string;
  server: SoundControls;
  /** Shown on the first one's device; all move together. */
  streams: readonly AudioStream[];
};

/**
 * A picker of the device the streams play to or record from. The hardware
 * behind a filter is left out unless they play to it: it would skip the
 * filter.
 */
const StreamDevice = ({
  devices,
  label,
  server,
  streams,
}: StreamDeviceProps) => (
  <Select<string>
    aria-label={label}
    onValueChange={(device) => {
      if (device !== null) {
        for (const stream of streams) {
          ask(server.moveStream(stream.id, device));
        }
      }
    }}
    options={devices
      .filter((device) => !device.filtered || device.id === streams[0]?.device)
      .map((device) => ({
        label: device.description,
        value: device.id,
      }))}
    size="sm"
    surface="filled"
    value={streams[0]?.device ?? null}
  />
);

type CardsProps = {
  cards: readonly AudioCard[];
  server: SoundControls;
};

/** Each sound card's mode, under the card's name. */
const Cards = ({ cards, server }: CardsProps) =>
  cards.map((card) => (
    <PanelSection key={card.id} label={card.description}>
      <Select<string>
        aria-label={card.description}
        onValueChange={(profile) => {
          if (profile !== null && profile !== card.profile) {
            ask(server.setProfile(card.id, profile));
          }
        }}
        options={card.profiles.map(modeOption)}
        size="sm"
        surface="filled"
        value={card.profile ?? null}
      />
    </PanelSection>
  ));

/** A card's mode as an option, marked when unavailable. */
const modeOption = (
  profile: AudioCard["profiles"][number],
): SelectOption<string> => ({
  label: profile.available
    ? profileName(profile)
    : `${profileName(profile)} (unavailable)`,
  value: profile.name,
});

// Sections a step apart.
const mainStyles = flex({
  direction: "column",
  gap: 3,
  minInlineSize: 0,
});

// Each app sits close over its volume, a step from the next app.
const appStyles = flex({ direction: "column", gap: 0.5 });

const choiceStyles = hstack({ gap: 2.5 });

const choiceIconStyles = css({ display: "inline-flex", flexShrink: 0 });

const choiceDetailStyles = css({
  color: "textSoft",
  display: "block",
  textStyle: "panelDetail",
});
