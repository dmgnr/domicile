import { Button } from "@domicile-desktop/component-library/Button";
import { Card } from "@domicile-desktop/component-library/Card";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { Input } from "@domicile-desktop/component-library/Input";
import { ModalDialog } from "@domicile-desktop/component-library/ModalDialog";
import { DatabaseIcon } from "@phosphor-icons/react/dist/ssr/Database";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash";
import { useState } from "react";

import { css } from "../../styled-system/css";
import { byteSize } from "../byte-size";
import type { Report } from "../config-editor";
import type { SettingsHost, SiteData } from "../host";
import { Notice } from "../Notice";
import { Page } from "../Page";
import { SettingRow } from "../SettingRow";
import { useSiteData } from "../useSiteData";

type Props = {
  title: string;
  description: string;
  host: SettingsHost;
  report: Report;
};

/**
 * Each site that stores data in browser windows, largest first, found by name
 * and removed after a confirmation.
 */
export const SiteDataPage = ({ description, host, report, title }: Props) => {
  const { clear, failure, sites } = useSiteData(host, report);
  const [search, setSearch] = useState("");
  // Kept after the dialog closes, so its title holds while it fades out.
  const [removing, setRemoving] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const shown = sites === undefined ? undefined : found(sites, search);
  return (
    <Page description={description} title={title}>
      {failure !== undefined && (
        <Notice tone="danger">
          Couldn't list site data:{" "}
          {failure instanceof Error ? failure.message : String(failure)}
        </Notice>
      )}
      {shown !== undefined && (
        <Card>
          <Input
            aria-label="Search sites"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search sites"
            size="sm"
            type="search"
            value={search}
          />
          {shown.length === 0 ? (
            <EmptyState
              {...(search.trim() === ""
                ? {
                    hint: "Sites you visit that save cookies show up here.",
                    icon: DatabaseIcon,
                    title: "No site stores data",
                  }
                : {
                    hint: "Try another name.",
                    icon: MagnifyingGlassIcon,
                    title: "No site matches",
                  })}
            />
          ) : (
            <div>
              {shown.map((site) => (
                <SettingRow
                  hint={stored(site)}
                  key={site.host}
                  title={site.host}
                >
                  <Button
                    label={`Remove ${site.host}'s data`}
                    onClick={() => {
                      setRemoving(site.host);
                      setConfirming(true);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <TrashIcon size={14} />
                  </Button>
                </SettingRow>
              ))}
            </div>
          )}
        </Card>
      )}
      {removing !== undefined && (
        <RemoveDialog
          host={removing}
          onConfirm={() => {
            clear(removing);
            setConfirming(false);
          }}
          onOpenChange={setConfirming}
          open={confirming}
        />
      )}
    </Page>
  );
};

type RemoveDialogProps = {
  host: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/** Asks before a site's data is removed. */
const RemoveDialog = ({
  host,
  onConfirm,
  onOpenChange,
  open,
}: RemoveDialogProps) => (
  <ModalDialog
    footer={
      <>
        <ModalDialog.CloseButton variant="ghost">
          Cancel
        </ModalDialog.CloseButton>
        <Button onClick={onConfirm} variant="danger">
          Remove
        </Button>
      </>
    }
    onOpenChange={onOpenChange}
    open={open}
    title={`Remove ${host}'s data?`}
  >
    <p className={hintStyles}>
      Its cookies and everything else it stores on this computer are removed,
      which signs you out of it.
    </p>
  </ModalDialog>
);

/** The sites whose host has `search`, largest first. */
const found = (sites: SiteData[], search: string): SiteData[] => {
  const wanted = search.trim().toLowerCase();
  return sites
    .filter(({ host }) => host.includes(wanted))
    .toSorted((a, b) => b.bytes - a.bytes || a.host.localeCompare(b.host));
};

/** A site's size, and its cookies when it has any. */
const stored = ({ bytes, cookies }: SiteData): string =>
  cookies === 0
    ? byteSize(bytes)
    : `${byteSize(bytes)} · ${cookies} ${cookies === 1 ? "cookie" : "cookies"}`;

const hintStyles = css({ color: "muted", fontSize: "xs", margin: 0 });
