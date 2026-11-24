import { Button } from "@domicile-desktop/component-library/Button";
import { Card } from "@domicile-desktop/component-library/Card";
import { useEffect, useState } from "react";

import type { Report } from "../config-editor";
import type { ExportedLogs, SettingsHost } from "../host";
import { Notice } from "../Notice";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { SwitchRow } from "../SwitchRow";

type Props = {
  title: string;
  description: string;
  host: SettingsHost;
  report: Report;
};

/**
 * Detailed logging, which `domicile set-log-level debug` turns on until the
 * desktop restarts, and Save logs, which is `domicile export-logs` into
 * Downloads. See `docs/LOGGING.md`.
 */
export const TroubleshootingPage = ({
  description,
  host,
  report,
  title,
}: Props) => {
  const [detailed, setDetailed] = useState<boolean | undefined>(undefined);
  const [hide, setHide] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ExportedLogs | undefined>(undefined);

  useEffect(() => {
    host
      .detailedLogging()
      .then(setDetailed, report("Couldn't read whether logging is detailed"));
  }, [host, report]);

  const save = () => {
    setSaving(true);
    host
      .exportLogs(hide)
      .then(setSaved, report("Couldn't save the logs"))
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Page description={description} title={title}>
      <Card>
        <SwitchRow
          checked={detailed ?? false}
          disabled={detailed === undefined}
          hint="Records much more about what the desktop does, to help track down a problem. Turns off when the desktop restarts."
          label="Detailed logging"
          onChange={(on) => {
            host
              .setDetailedLogging(on)
              .then(
                setDetailed,
                report(`Couldn't turn detailed logging ${on ? "on" : "off"}`),
              );
          }}
        />
      </Card>
      {saved !== undefined && (
        <Notice>
          Saved {fileName(saved.path)} in Downloads.
          {saved.unhidden !== undefined && ` Note: ${saved.unhidden}.`}{" "}
          <Button
            onClick={() => {
              host.openDownloads().catch(report("Couldn't open Downloads"));
            }}
            size="sm"
            variant="outline"
          >
            Open Downloads
          </Button>
        </Notice>
      )}
      <Card>
        <SettingRow
          hint="Saves what the desktop recorded since it started to a file in Downloads, to attach to a bug report."
          title="Save logs"
        >
          <Button loading={saving} onClick={save} size="sm">
            Save logs
          </Button>
        </SettingRow>
        <SwitchRow
          checked={hide}
          disabled={false}
          hint="They show what you were doing. Turn this off only if the problem is with a particular site or window."
          label="Hide web addresses and window titles"
          onChange={setHide}
        />
      </Card>
    </Page>
  );
};

/** The last part of `path`. */
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
