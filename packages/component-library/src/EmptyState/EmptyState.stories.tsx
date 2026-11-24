import { BellSimpleIcon } from "@phosphor-icons/react/dist/ssr/BellSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { WifiSlashIcon } from "@phosphor-icons/react/dist/ssr/WifiSlash";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../Button/Button";
import {
  EmptyState as EmptyStateComponent,
  LAYOUTS,
  TONES,
} from "./EmptyState";

const meta = {
  args: {
    hint: "Turn it on to see networks nearby.",
    icon: WifiSlashIcon,
    title: "Wi-Fi is off",
  },
  argTypes: {
    action: { control: false, table: { category: "Contents" } },
    detail: { control: "text", table: { category: "Contents" } },
    hint: { control: "text", table: { category: "Contents" } },
    icon: { control: false, table: { category: "Contents" } },
    layout: {
      control: "inline-radio",
      options: LAYOUTS,
      table: { category: "Appearance" },
    },
    title: { control: "text", table: { category: "Contents" } },
    tone: {
      control: "inline-radio",
      options: TONES,
      table: { category: "Appearance" },
    },
  },
  component: EmptyStateComponent,
  parameters: {
    docs: {
      description: {
        component:
          "A panel with nothing to show: an icon, what is missing, and what would fill it, in plain words, with a button that would fill it if there is one.",
      },
    },
  },
  tags: ["autodocs"],
  title: "Panels/EmptyState",
} satisfies Meta<typeof EmptyStateComponent>;
export default meta;

export const WithHint: StoryObj<typeof EmptyStateComponent> = {};

export const TitleOnly: StoryObj<typeof EmptyStateComponent> = {
  args: {
    hint: undefined,
    icon: BellSimpleIcon,
    title: "You're all caught up",
  },
};

export const WithAction: StoryObj<typeof EmptyStateComponent> = {
  args: {
    action: (
      <Button rounded size="xs">
        Look again
      </Button>
    ),
    hint: "Move closer to your router, then look again.",
    icon: MagnifyingGlassIcon,
    title: "No networks nearby",
  },
};

export const Warning: StoryObj<typeof EmptyStateComponent> = {
  args: {
    detail: "The name net.connman.iwd was not provided",
    hint: "Close this and open it again in a moment.",
    icon: undefined,
    title: "Couldn't read Wi-Fi",
    tone: "warning",
  },
};

export const Inline: StoryObj<typeof EmptyStateComponent> = {
  args: {
    hint: undefined,
    icon: undefined,
    layout: "inline",
    title: "No other networks nearby",
  },
};
