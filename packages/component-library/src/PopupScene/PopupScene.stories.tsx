import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../Button/Button";
import { Popover } from "../Popover/Popover";
import { PopupScene as PopupSceneComponent } from "./PopupScene";

const meta = {
  args: {
    children: (
      <Popover defaultOpen trigger={<Button>Details</Button>}>
        Change the scene to close this.
      </Popover>
    ),
    scene: "desk",
  },
  argTypes: {
    children: {
      control: false,
      table: { category: "Contents" },
    },
    scene: {
      control: "text",
      table: { category: "Behavior" },
    },
  },
  component: PopupSceneComponent,
  parameters: {
    docs: {
      description: {
        component:
          "Closes every popup opened inside when its scene changes, such as when an overview opens over the windows they point at.",
      },
    },
  },
  tags: ["autodocs"],
  title: "Overlays/PopupScene",
} satisfies Meta<typeof PopupSceneComponent>;
export default meta;

export const PopupScene: StoryObj<typeof PopupSceneComponent> = {};
