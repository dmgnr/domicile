import { BluetoothIcon } from "@phosphor-icons/react/dist/ssr/Bluetooth";
import { NetworkIcon } from "@phosphor-icons/react/dist/ssr/Network";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { css } from "../../styled-system/css";

import { QuickTile as QuickTileComponent } from "./QuickTile";

const meta = {
  args: {
    detail: "WH-1000XM4",
    icon: <BluetoothIcon size={15} weight="bold" />,
    label: "Bluetooth",
    lit: true,
    onMore: () => undefined,
  },
  component: QuickTileComponent,
  decorators: [
    (Story) => (
      <div className={frameStyles}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A quick settings tile into the details of something nearly always on, such as Wi-Fi. Without details it only shows its state.",
      },
    },
  },
  tags: ["autodocs"],
  title: "Forms & Inputs/QuickTile",
} satisfies Meta<typeof QuickTileComponent>;
export default meta;

export const Details: StoryObj<typeof QuickTileComponent> = {};

export const Wired: StoryObj<typeof QuickTileComponent> = {
  args: {
    detail: "Connected, 1 Gb/s",
    icon: <NetworkIcon size={15} weight="bold" />,
    label: "Wired",
    lit: true,
  },
};

export const Unlit: StoryObj<typeof QuickTileComponent> = {
  args: { detail: "Not connected", lit: false },
};

export const StateOnly: StoryObj<typeof QuickTileComponent> = {
  args: { onMore: undefined },
};
const frameStyles = css({ inlineSize: 40 });
