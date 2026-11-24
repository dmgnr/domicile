import type { Meta, StoryObj } from "@storybook/react-vite";

import { MenuBar as MenuBarComponent } from "./MenuBar";

const meta = {
  args: {
    children: (
      <>
        <MenuBarComponent.Menu label="File" mnemonic={0}>
          <MenuBarComponent.Item mnemonic={0} shortcut="Ctrl+N">
            New Conversation
          </MenuBarComponent.Item>
          <MenuBarComponent.Item mnemonic={0} shortcut="Ctrl+,">
            Settings…
          </MenuBarComponent.Item>
          <MenuBarComponent.Separator />
          <MenuBarComponent.Item mnemonic={0} shortcut="Ctrl+W">
            Close Window
          </MenuBarComponent.Item>
          <MenuBarComponent.Item mnemonic={0} shortcut="Ctrl+Q">
            Quit Claude
          </MenuBarComponent.Item>
        </MenuBarComponent.Menu>
        <MenuBarComponent.Menu label="Edit" mnemonic={0}>
          <MenuBarComponent.Item shortcut="Ctrl+Z">Undo</MenuBarComponent.Item>
          <MenuBarComponent.Item shortcut="Ctrl+Shift+Z">
            Redo
          </MenuBarComponent.Item>
        </MenuBarComponent.Menu>
        <MenuBarComponent.Menu label="View" mnemonic={0}>
          <MenuBarComponent.CheckboxItem checked>
            Sidebar
          </MenuBarComponent.CheckboxItem>
        </MenuBarComponent.Menu>
        <MenuBarComponent.Menu label="Window" mnemonic={0}>
          <MenuBarComponent.Item>Minimize</MenuBarComponent.Item>
        </MenuBarComponent.Menu>
        <MenuBarComponent.Menu label="Help" mnemonic={0}>
          <MenuBarComponent.Item>About Claude</MenuBarComponent.Item>
        </MenuBarComponent.Menu>
      </>
    ),
    label: "Claude",
  },
  argTypes: {
    children: {
      control: false,
      table: { category: "Contents" },
    },
    label: {
      control: "text",
      table: { category: "Contents" },
    },
  },
  component: MenuBarComponent,
  parameters: {
    docs: {
      description: {
        component:
          "An app's menu bar, wrapping the @base-ui/react Menubar primitive, with ContextMenu's items.",
      },
    },
  },
  tags: ["autodocs"],
  title: "Overlays/MenuBar",
} satisfies Meta<typeof MenuBarComponent>;
export default meta;

export const MenuBar: StoryObj<typeof MenuBarComponent> = {};
