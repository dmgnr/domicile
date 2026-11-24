import { Button } from "@domicile-desktop/component-library/Button";
import { EmptyState } from "@domicile-desktop/component-library/EmptyState";
import { Loading } from "@domicile-desktop/component-library/Loading";
import { DevicesIcon } from "@phosphor-icons/react/dist/ssr/Devices";
import { useId, useState } from "react";

import { css } from "../styled-system/css";
import { hstack, vstack } from "../styled-system/patterns";
import type { DeviceRequest } from "./useDeviceRequest";

type Props = { request: DeviceRequest };

/**
 * A page's device request: Chrome's question, the devices to pick from, and
 * the two answers. Nothing starts picked, as in Chrome's chooser.
 */
export const DeviceAsk = ({ request }: Props) => {
  const titleId = useId();
  const group = useId();
  const [picked, setPicked] = useState<number | undefined>(undefined);
  // A device unplugged after it was picked no longer counts.
  const chosen = request.devices?.some(({ id }) => id === picked)
    ? picked
    : undefined;
  return (
    <section aria-labelledby={titleId} className={askingStyles}>
      <span className={askingTextStyles} id={titleId}>
        {request.title}
      </span>
      {request.devices === undefined && (
        <Loading icon={DevicesIcon}>Looking for devices…</Loading>
      )}
      {request.devices?.length === 0 && (
        <EmptyState
          hint="Plug in or turn on the device, and it shows up here."
          icon={DevicesIcon}
          title="No devices found"
        />
      )}
      {request.devices !== undefined && request.devices.length > 0 && (
        <ul aria-label="Devices" className={devicesStyles}>
          {request.devices.map((device) => (
            <li key={device.id}>
              <label className={deviceStyles}>
                <input
                  checked={device.id === chosen}
                  name={group}
                  onChange={() => {
                    setPicked(device.id);
                  }}
                  type="radio"
                />
                {device.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className={answersStyles}>
        <Button onClick={request.cancel} size="sm" variant="primary">
          Cancel
        </Button>
        <Button
          disabled={chosen === undefined}
          onClick={() => {
            if (chosen !== undefined) {
              request.choose(chosen);
            }
          }}
          size="sm"
          variant="accent"
        >
          Connect
        </Button>
      </div>
    </section>
  );
};

// Tinted with the accent, as `PermissionAsk` is.
const askingStyles = vstack({
  alignItems: "stretch",
  backgroundColor: "color-mix(in oklab, {colors.accent} 10%, {colors.card})",
  border: "1px solid color-mix(in oklab, {colors.accent} 35%, {colors.border})",
  borderRadius: "lg",
  gap: 2.5,
  padding: 3,
});

const askingTextStyles = css({
  color: "foreground",
  fontSize: "sm",
  fontWeight: "semibold",
  overflowWrap: "anywhere",
});

const devicesStyles = vstack({
  alignItems: "stretch",
  gap: 1,
  listStyle: "none",
  margin: 0,
  maxBlockSize: 40,
  overflowY: "auto",
  padding: 0,
});

const deviceStyles = hstack({
  _hover: {
    backgroundColor: "color-mix(in oklab, {colors.accent} 18%, {colors.card})",
  },
  borderRadius: "md",
  color: "foreground",
  cursor: "pointer",
  fontSize: "sm",
  gap: 2,
  paddingBlock: 1,
  paddingInline: 2,
});

// Equal halves, Cancel first, as in Chrome's chooser.
const answersStyles = css({
  "& > *": { flex: "1 1 0" },
  display: "flex",
  gap: 2,
});
