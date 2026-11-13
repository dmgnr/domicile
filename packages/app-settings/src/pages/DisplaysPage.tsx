import { Button } from "@domicile-desktop/component-library/Button";
import { Card } from "@domicile-desktop/component-library/Card";
import { Select } from "@domicile-desktop/component-library/Select";
import { Switch } from "@domicile-desktop/component-library/Switch";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";
import type { ReactNode } from "react";
import { useId } from "react";

import { css } from "../../styled-system/css";
import { flex, grid } from "../../styled-system/patterns";
import { AddRow } from "../AddRow";
import type { ConfigPath } from "../config-document";
import type { ConfigEditor, ConfigPageProps } from "../config-editor";
import type { Display, Placement, Profile, TRANSFORMS } from "../config-schema";
import type { NumberRule } from "../number-text";
import { parseNumber } from "../number-text";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { TextSetting } from "../TextSetting";

const ROTATIONS = [
  { label: "None", value: "normal" },
  { label: "90°", value: "rotate-90" },
  { label: "180°", value: "rotate-180" },
  { label: "270°", value: "rotate-270" },
] as const satisfies readonly {
  label: string;
  value: (typeof TRANSFORMS)[number];
}[];

const WHOLE = { integer: true, positive: false } as const;
const COUNT = { integer: true, positive: true } as const;
const SCALE = { integer: false, positive: true } as const;
/** An everyday white in cd/m², which PQ encodes up to 10000. */
const NITS = { integer: true, positive: true } as const;
/** The everyday white the desktop uses in HDR when a profile states none. */
const DEFAULT_SDR_WHITE = 203;
const ORIGIN = [0, 0] as const;

/** `output`: the profiles that place monitors, and described displays. */
export const DisplaysPage = ({
  description,
  editor,
  title,
}: ConfigPageProps) => {
  const { readOnly, settings } = editor;
  const { output } = settings;
  const disabled = readOnly !== undefined;
  return (
    <Page description={description} readOnly={readOnly} title={title}>
      <Card>
        <SettingRow
          hint="For Domicile's own window when no displays are described below. 1 turns scaling off."
          title="Highest scale"
        >
          <NumberSetting
            editor={editor}
            fallback={2}
            label="Highest scale"
            path={["output", "max_scale"]}
            rule={COUNT}
            value={output.max_scale}
          />
        </SettingRow>
      </Card>
      {output.profiles.map((profile, index) => (
        <ProfileCard
          editor={editor}
          index={index}
          key={`${index}-${profile.name}`}
          profile={profile}
          profiles={output.profiles.length}
        />
      ))}
      {!disabled && (
        <Card title="New profile">
          <AddRow
            button="Add profile"
            label="New profile name"
            onAdd={(name) => {
              editor.set(["output", "profiles", output.profiles.length], {
                displays: [],
                name,
              });
            }}
            placeholder="desk"
          />
        </Card>
      )}
      <Card title="Described displays">
        <p className={hintStyles}>
          For a nested desktop, which has no monitors to find. Sizes and
          positions are in logical pixels.
        </p>
        {output.displays.length > 0 && (
          <div aria-hidden className={describedStyles}>
            {["Display", "Width", "Height", "X", "Y", "Scale"].map(
              (heading) => (
                <span className={headingStyles} key={heading}>
                  {heading}
                </span>
              ),
            )}
          </div>
        )}
        {output.displays.map((display, index) => (
          <DescribedDisplay
            display={display}
            editor={editor}
            index={index}
            key={`${index}-${display.name}`}
          />
        ))}
        {!disabled && (
          <AddRow
            button="Add display"
            label="New display name"
            onAdd={(name) => {
              editor.set(["output", "displays", output.displays.length], {
                name,
                size: [1920, 1080],
              });
            }}
            placeholder="left"
          />
        )}
      </Card>
    </Page>
  );
};

type ProfileCardProps = {
  editor: ConfigEditor;
  profile: Profile;
  index: number;
  profiles: number;
};

/** A profile: its name, and where it puts each monitor. */
const ProfileCard = ({
  editor,
  index,
  profile,
  profiles,
}: ProfileCardProps) => {
  const { readOnly, set } = editor;
  const disabled = readOnly !== undefined;
  const path = ["output", "profiles", index] as const;
  return (
    <Card title={`Profile: ${profile.name}`}>
      <SettingRow
        hint="The first profile whose monitors are all plugged in applies."
        title="Name"
      >
        <TextSetting
          disabled={disabled}
          label={`Profile ${index + 1} name`}
          onCommit={(name) => {
            if (name.trim() === "") {
              return false;
            } else {
              set([...path, "name"], name.trim());
              return true;
            }
          }}
          value={profile.name}
        />
      </SettingRow>
      {profile.displays.length > 0 && (
        <div className={placementsStyles}>
          <div aria-hidden className={headingsStyles}>
            {PLACEMENT_HEADINGS.map((heading, at) => (
              <span className={headingStyles} key={`${at}-${heading}`}>
                {heading}
              </span>
            ))}
          </div>
          {profile.displays.map((placement, at) => (
            <PlacementRow
              editor={editor}
              key={`${at}-${placement.display}`}
              path={[...path, "displays", at]}
              placement={placement}
            />
          ))}
          <p className={hintStyles}>
            HDR turns on only for monitors that support it. Everyday brightness
            is how bright windows and the desktop look while HDR is on; raise it
            if they seem dim.
          </p>
        </div>
      )}
      {!disabled && (
        <div className={actionsStyles}>
          <AddRow
            button="Add monitor"
            label={`Add a monitor to ${profile.name}`}
            onAdd={(display) => {
              set([...path, "displays", profile.displays.length], { display });
            }}
            placeholder="DEL DELL U3219Q 2ZLS413"
          />
          <Button
            beforeIcon={<TrashIcon size={14} />}
            onClick={() => {
              set(profiles === 1 ? ["output", "profiles"] : path, undefined);
            }}
            size="sm"
            variant="ghost"
          >
            {`Remove ${profile.name}`}
          </Button>
        </div>
      )}
    </Card>
  );
};

type PlacementRowProps = {
  editor: ConfigEditor;
  placement: Placement;
  path: ConfigPath;
};

/** The grid's column headings; a narrow card labels each setting instead. */
const PLACEMENT_HEADINGS = [
  "Monitor",
  "",
  "Scale",
  "X",
  "Y",
  "Rotation",
  "HDR",
  "Everyday brightness",
] as const;

/**
 * One monitor in a profile: on or off, its scale, position, rotation and
 * HDR. A row of the grid, or on a narrow card a stack of labeled settings.
 */
const PlacementRow = ({ editor, path, placement }: PlacementRowProps) => {
  const { readOnly, set } = editor;
  const disabled = readOnly !== undefined;
  const name = placement.display;
  const nameId = useId();
  return (
    <div className={placementStyles}>
      <code className={nameStyles} id={nameId}>
        {name}
      </code>
      <Field label="On">
        <Switch
          aria-labelledby={nameId}
          checked={placement.enabled}
          disabled={disabled}
          label={placement.enabled ? "On" : "Off"}
          onCheckedChange={(enabled) => {
            set([...path, "enabled"], enabled ? undefined : false);
          }}
        />
      </Field>
      <Field label="Scale">
        <NumberSetting
          editor={editor}
          fallback={1}
          label={`${name} scale`}
          path={[...path, "scale"]}
          rule={SCALE}
          value={placement.scale}
        />
      </Field>
      <Field label="Position">
        <PositionSetting
          editor={editor}
          fallback={undefined}
          name={name}
          path={[...path, "position"]}
          position={placement.position}
        />
      </Field>
      <Field label="Rotation">
        <Select
          aria-label={`${name} rotation`}
          disabled={disabled}
          onValueChange={(transform) => {
            set(
              [...path, "transform"],
              transform === "normal" ? undefined : transform,
            );
          }}
          options={ROTATIONS}
          size="sm"
          value={placement.transform}
        />
      </Field>
      <Field label="HDR">
        <Switch
          checked={placement.hdr === true}
          disabled={disabled}
          hideLabel
          label={`${name} HDR`}
          onCheckedChange={(hdr) => {
            set([...path, "hdr"], hdr ? true : undefined);
          }}
        />
      </Field>
      {placement.hdr === true ? (
        <Field label="Everyday brightness">
          <span className={nitsStyles}>
            <NumberSetting
              editor={editor}
              fallback={DEFAULT_SDR_WHITE}
              label={`${name} everyday brightness`}
              path={[...path, "sdr_white"]}
              rule={NITS}
              value={placement.sdr_white ?? DEFAULT_SDR_WHITE}
            />
            nits
          </span>
        </Field>
      ) : (
        <span className={emptyCellStyles} />
      )}
      {!disabled && (
        <Button
          label={`Remove ${name}`}
          onClick={() => {
            set(path, undefined);
          }}
          size="sm"
          variant="ghost"
        >
          <XIcon size={14} />
        </Button>
      )}
    </div>
  );
};

type FieldProps = {
  children: ReactNode;
  label: string;
};

/**
 * One setting in a monitor's row: its grid cell, or on a narrow card a line
 * with its label, which the grid's headings otherwise give.
 */
const Field = ({ children, label }: FieldProps) => (
  <div className={fieldStyles}>
    <span aria-hidden className={fieldLabelStyles}>
      {label}
    </span>
    <div className={fieldControlStyles}>{children}</div>
  </div>
);

type DescribedDisplayProps = {
  editor: ConfigEditor;
  display: Display;
  index: number;
};

/** A display described outright: its size, position and scale. */
const DescribedDisplay = ({
  display,
  editor,
  index,
}: DescribedDisplayProps) => {
  const { readOnly, set } = editor;
  const path = ["output", "displays", index] as const;
  const name = display.name;
  return (
    <div className={describedStyles}>
      <code className={nameStyles}>{name}</code>
      <NumberSetting
        editor={editor}
        label={`${name} width`}
        path={[...path, "size", 0]}
        rule={COUNT}
        value={display.size[0]}
      />
      <NumberSetting
        editor={editor}
        label={`${name} height`}
        path={[...path, "size", 1]}
        rule={COUNT}
        value={display.size[1]}
      />
      <PositionSetting
        editor={editor}
        fallback={ORIGIN}
        name={name}
        path={[...path, "position"]}
        position={display.position}
      />
      <NumberSetting
        editor={editor}
        fallback={1}
        label={`${name} scale`}
        path={[...path, "scale"]}
        rule={COUNT}
        value={display.scale}
      />
      {readOnly === undefined && (
        <Button
          label={`Remove ${name}`}
          onClick={() => {
            set(path, undefined);
          }}
          size="sm"
          variant="ghost"
        >
          <XIcon size={14} />
        </Button>
      )}
    </div>
  );
};

type Point = readonly [number, number];

type PositionSettingProps = {
  editor: ConfigEditor;
  name: string;
  path: ConfigPath;
  position: Point | undefined;
  /**
   * The default, which is written as no value. Without one, a cleared field
   * writes no position, and the desktop places the display.
   */
  fallback: Point | undefined;
};

/** A position's x and y, written together. */
const PositionSetting = ({
  editor,
  fallback,
  name,
  path,
  position,
}: PositionSettingProps) => {
  const [x, y] = position ?? [undefined, undefined];
  const commit = (next: Point | undefined) => {
    editor.set(
      path,
      next === undefined ||
        (fallback !== undefined &&
          next[0] === fallback[0] &&
          next[1] === fallback[1])
        ? undefined
        : next,
    );
  };
  const onEmpty =
    fallback === undefined
      ? () => {
          commit(undefined);
        }
      : undefined;
  return (
    <>
      <NumberInput
        editor={editor}
        label={`${name} x`}
        onEmpty={onEmpty}
        onNumber={(value) => {
          commit([value, y ?? 0]);
        }}
        rule={WHOLE}
        value={x}
      />
      <NumberInput
        editor={editor}
        label={`${name} y`}
        onEmpty={onEmpty}
        onNumber={(value) => {
          commit([x ?? 0, value]);
        }}
        rule={WHOLE}
        value={y}
      />
    </>
  );
};

type NumberSettingProps = {
  editor: ConfigEditor;
  label: string;
  path: ConfigPath;
  rule: NumberRule;
  value: number;
  /** The default, which is written as no value. */
  fallback?: number | undefined;
};

/** A number at `path`. */
const NumberSetting = ({
  editor,
  fallback,
  label,
  path,
  rule,
  value,
}: NumberSettingProps) => (
  <NumberInput
    editor={editor}
    label={label}
    onNumber={(number) => {
      editor.set(path, number === fallback ? undefined : number);
    }}
    rule={rule}
    value={value}
  />
);

type NumberInputProps = {
  editor: ConfigEditor;
  label: string;
  rule: NumberRule;
  /** `undefined` shows an empty field. */
  value: number | undefined;
  onNumber: (value: number) => void;
  /** Takes a cleared field. Without it, an empty field is refused. */
  onEmpty?: (() => void) | undefined;
};

/** A narrow text field that takes a number, reporting one it refuses. */
const NumberInput = ({
  editor,
  label,
  onEmpty,
  onNumber,
  rule,
  value,
}: NumberInputProps) => (
  <TextSetting
    disabled={editor.readOnly !== undefined}
    label={label}
    onCommit={(text) => {
      if (onEmpty !== undefined && text.trim() === "") {
        onEmpty();
        return true;
      } else {
        return parseNumber(text, rule).match({
          Err: (why) => {
            editor.report(`Not a ${label}`)(why);
            return false;
          },
          Ok: (number) => {
            onNumber(number);
            return true;
          },
        });
      }
    }}
    placeholder={onEmpty === undefined ? undefined : "Auto"}
    value={value?.toString() ?? ""}
    width={16}
  />
);

const hintStyles = css({ color: "muted", fontSize: "xs", margin: 0 });

/** Below this width, each monitor's settings stack into labeled lines. */
const NARROW = "@container (max-width: 44rem)";

const PLACEMENT_COLUMNS =
  "minmax(0, 1fr) auto {spacing.16} {spacing.16} {spacing.16} {spacing.28} auto {spacing.28} {spacing.8}";

const placementsStyles = flex({
  containerType: "inline-size",
  direction: "column",
  gap: 3,
});

const headingsStyles = grid({
  [NARROW]: { display: "none" },
  alignItems: "center",
  columnGap: 2,
  gridTemplateColumns: PLACEMENT_COLUMNS,
});

const placementStyles = grid({
  [NARROW]: {
    borderBlockEnd: "1px solid {colors.border}",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    paddingBlockEnd: 3,
    rowGap: 2.5,
  },
  alignItems: "center",
  columnGap: 2,
  gridTemplateColumns: PLACEMENT_COLUMNS,
});

const fieldStyles = css({
  [NARROW]: {
    alignItems: "center",
    display: "flex",
    gap: 2,
    gridColumn: "1 / -1",
    gridRow: "auto",
    justifyContent: "space-between",
  },
  display: "contents",
});

const fieldLabelStyles = css({
  [NARROW]: { display: "inline" },
  color: "muted",
  display: "none",
  fontSize: "sm",
});

const fieldControlStyles = css({
  [NARROW]: { display: "flex", gap: 2 },
  display: "contents",
});

const nitsStyles = flex({
  align: "center",
  color: "muted",
  fontSize: "xs",
  gap: 1.5,
});

const emptyCellStyles = css({ [NARROW]: { display: "none" } });

const describedStyles = grid({
  alignItems: "center",
  columnGap: 2,
  gridTemplateColumns:
    "minmax(0, 1fr) {spacing.16} {spacing.16} {spacing.16} {spacing.16} {spacing.16} {spacing.8}",
});

const headingStyles = css({ color: "muted", fontSize: "xs" });

const nameStyles = css({
  fontFamily: "mono",
  fontSize: "xs",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const actionsStyles = flex({
  align: "center",
  gap: 2,
  justify: "space-between",
  wrap: "wrap",
});
