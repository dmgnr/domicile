import { Button } from "@domicile-desktop/component-library/Button";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { List, ListRow } from "@domicile-desktop/component-library/ListRow";
import { PanelFooter } from "@domicile-desktop/component-library/PanelFooter";
import { Switch } from "@domicile-desktop/component-library/Switch";
import { useRequests } from "@domicile-desktop/manganese-host/useRequests";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type {
  SavedWifi,
  Wifi,
  WifiNetwork,
} from "@domicile-desktop/system-network/wifi";
import { WifiSecurity } from "@domicile-desktop/system-network/wifi";
import { BookmarkSimpleIcon } from "@phosphor-icons/react/dist/ssr/BookmarkSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash";
import { WifiHighIcon } from "@phosphor-icons/react/dist/ssr/WifiHigh";

import { css } from "../styled-system/css";
import { Failure } from "./Failure";
import { WifiSignalIcon } from "./WifiSignalIcon";
import type { WifiActions } from "./wifi-actions";

type Props = {
  wifi: Wifi;
  /** Where requests go. */
  host: Domicile;
  actions: WifiActions;
  /** What "today" and "yesterday" are counted from. */
  now?: Date | undefined;
};

/**
 * Every saved network, each a tile with all it offers in view: when it was
 * last used, how it is secured, whether it joins by itself, and Forget.
 *
 * The connected network leads, then those in range, then the rest, most
 * recently used first.
 */
export const SavedNetworks = ({
  actions,
  host,
  now = new Date(),
  wifi,
}: Props) => {
  const requests = useRequests();
  const inRange = new Map(
    wifi.networks.flatMap((network) =>
      network.profile === undefined ? [] : [[network.profile, network]],
    ),
  );
  return wifi.saved.length === 0 ? (
    <EmptyState icon={BookmarkSimpleIcon} title="No saved networks" />
  ) : (
    <List label="Saved networks">
      {orderOf(wifi.saved, inRange).map((saved) => {
        const network = inRange.get(saved.profile);
        const forget = `forget:${saved.profile}`;
        const autoJoin = `autoJoin:${saved.profile}`;
        return (
          <ListRow
            detail={detailOf(saved, network, now)}
            icon={
              network === undefined ? (
                <span className={awayStyles}>
                  <WifiHighIcon aria-hidden size={15} />
                </span>
              ) : (
                <WifiSignalIcon strength={network.strength} />
              )
            }
            key={saved.profile}
            label={saved.ssid}
            surface="filled"
          >
            <Failure error={requests.failed(forget)}>
              Couldn't forget {saved.ssid}
            </Failure>
            <Failure error={requests.failed(autoJoin)}>
              Couldn't change {saved.ssid}
            </Failure>
            <PanelFooter
              action={
                <Button
                  beforeIcon={<TrashIcon aria-hidden size={14} />}
                  loading={requests.pending(forget)}
                  onClick={() => {
                    requests.run(forget, () =>
                      actions.forgetWifi(host, wifi, saved),
                    );
                  }}
                  rounded
                  size="xs"
                  variant="dangerGhost"
                >
                  Forget
                </Button>
              }
            >
              <Switch
                checked={saved.autoJoin}
                disabled={requests.pending(autoJoin)}
                label="Join automatically"
                onCheckedChange={(checked) => {
                  requests.run(autoJoin, () =>
                    actions.setWifiAutoJoin(host, wifi, saved, checked),
                  );
                }}
              />
            </PanelFooter>
          </ListRow>
        );
      })}
    </List>
  );
};

/** Connected, then in range, then most recently used; never used last. */
const orderOf = (
  saved: readonly SavedWifi[],
  inRange: ReadonlyMap<string, WifiNetwork>,
): SavedWifi[] =>
  saved.toSorted(
    (a, b) =>
      rankOf(a, inRange) - rankOf(b, inRange) ||
      (b.lastUsed?.getTime() ?? 0) - (a.lastUsed?.getTime() ?? 0),
  );

const rankOf = (
  saved: SavedWifi,
  inRange: ReadonlyMap<string, WifiNetwork>,
): number => {
  const network = inRange.get(saved.profile);
  if (network === undefined) {
    return 2;
  } else {
    return network.connected ? 0 : 1;
  }
};

/** Where it is, when it was last used, and how it is secured. */
const detailOf = (
  saved: SavedWifi,
  network: WifiNetwork | undefined,
  now: Date,
): string =>
  [
    ...(network === undefined
      ? []
      : [network.connected ? "Connected" : "In range"]),
    ...(network?.connected === true ? [] : [usedOf(saved.lastUsed, now)]),
    SECURITY[saved.security],
  ].join(" · ");

const SECURITY = {
  [WifiSecurity.Open]: "Open",
  [WifiSecurity.Password]: "Secured",
  [WifiSecurity.Enterprise]: "Enterprise",
} as const satisfies Record<WifiSecurity, string>;

const usedOf = (used: Date | undefined, now: Date): string =>
  used === undefined ? "Never used" : `Used ${dayOf(used, now)}`;

/** A day as people say it: today, yesterday, or its date, with its year if not this one. */
const dayOf = (day: Date, now: Date): string => {
  switch (daysBetween(day, now)) {
    case 0: {
      return "today";
    }
    case 1: {
      return "yesterday";
    }
    default: {
      return day.toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      });
    }
  }
};

/** Calendar days from `from` to `to`, in local time. */
const daysBetween = (from: Date, to: Date): number =>
  Math.round(
    (new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime() -
      new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()) /
      86_400_000,
  );

// Out of range: the network is there to manage, not to join.
const awayStyles = css({ display: "inline-flex", opacity: "inactive" });
