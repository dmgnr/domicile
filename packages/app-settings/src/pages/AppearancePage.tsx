import { Button } from "@domicile-desktop/component-library/Button";
import { Card } from "@domicile-desktop/component-library/Card";
import { Select } from "@domicile-desktop/component-library/Select";

import { ColorWell } from "../ColorWell";
import type { ConfigPageProps } from "../config-editor";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { SwitchRow } from "../SwitchRow";
import { TextSetting } from "../TextSetting";

const MODES = [
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
] as const;

/** What the accent color's well shows while none is set. */
const UNSET_SHOWN_AS = "#808080";

const CONTRASTS = [
  { label: "Normal", value: "normal" },
  { label: "High", value: "high" },
] as const;

/** `theme`: mode, accent color, contrast, motion and icons. */
export const AppearancePage = ({
  description,
  editor,
  title,
}: ConfigPageProps) => {
  const { readOnly, report, set, settings } = editor;
  const { theme } = settings;
  const disabled = readOnly !== undefined;
  return (
    <Page description={description} readOnly={readOnly} title={title}>
      <Card>
        <SettingRow
          hint="The shell and every window that follows the desktop's theme."
          title="Theme"
        >
          <Select
            aria-label="Theme"
            disabled={disabled}
            onValueChange={(mode) => {
              set(["theme", "mode"], mode === "dark" ? undefined : mode);
            }}
            options={MODES}
            size="sm"
            value={theme.mode}
            width={36}
          />
        </SettingRow>
        <SettingRow
          hint="The color windows highlight with. Unset, each app picks its own."
          title="Accent color"
        >
          <ColorWell
            disabled={disabled}
            label="Accent color"
            onCommit={(color) => {
              set(["theme", "accent_color"], color);
            }}
            unsetShownAs={UNSET_SHOWN_AS}
            value={theme.accent_color}
          />
          {theme.accent_color !== undefined && !disabled && (
            <Button
              onClick={() => {
                set(["theme", "accent_color"], undefined);
              }}
              size="sm"
              variant="ghost"
            >
              Use each app's own
            </Button>
          )}
        </SettingRow>
        <SettingRow
          hint="High draws text and edges at full strength."
          title="Contrast"
        >
          <Select
            aria-label="Contrast"
            disabled={disabled}
            onValueChange={(contrast) => {
              set(
                ["theme", "contrast"],
                contrast === "normal" ? undefined : contrast,
              );
            }}
            options={CONTRASTS}
            size="sm"
            value={theme.contrast}
            width={36}
          />
        </SettingRow>
        <SettingRow
          hint="An icon theme's directory name, such as Papirus-Dark. Empty uses hicolor."
          title="Icon theme"
        >
          <TextSetting
            disabled={disabled}
            label="Icon theme"
            onCommit={(name) => {
              const trimmed = name.trim();
              if (trimmed.includes("/")) {
                report("Not an icon theme")(
                  `${trimmed} is a path; name the theme's directory`,
                );
                return false;
              } else {
                set(
                  ["theme", "icon_theme"],
                  trimmed === "" ? undefined : trimmed,
                );
                return true;
              }
            }}
            placeholder="hicolor"
            value={theme.icon_theme ?? ""}
          />
        </SettingRow>
      </Card>
      <Card>
        <SwitchRow
          checked={theme.reduced_motion}
          disabled={disabled}
          hint="Animations and transitions run once, at their shortest."
          label="Reduce motion"
          onChange={(reduced) => {
            set(["theme", "reduced_motion"], reduced ? true : undefined);
          }}
        />
      </Card>
    </Page>
  );
};
