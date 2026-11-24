import { describe, expect, it } from "bun:test";

import { TouchBar } from "./touch-bar";

describe(TouchBar, () => {
  it("keeps the app's items, as Electron's does where there's no Touch Bar", () => {
    const button = new TouchBar.TouchBarButton({ label: "Send" });
    const spacer = new TouchBar.TouchBarSpacer({ size: "small" });

    const bar = new TouchBar({ escapeItem: spacer, items: [button] });
    button.label = "Sent";

    expect(bar.items).toEqual([button]);
    expect(bar.escapeItem).toBe(spacer);
    expect(button.label).toBe("Sent");
  });
});
