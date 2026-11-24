import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { WEBVIEW_GUEST_FOCUS_EVENT } from "@domicile-desktop/sdk/webview-element";
import { act, render } from "@testing-library/react";

import { PageViews } from "./PageViews";

/** The `<webview>`s drawn, by their `window` attribute. */
const drawn = (container: HTMLElement) =>
  new Map(
    [...container.querySelectorAll("webview")].map((view) => [
      view.getAttribute("window"),
      view,
    ]),
  );

describe("PageViews", () => {
  it("draws the window's views where the app put them, bottom first", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("app://claude/", { isApp: true });
    fake.openBrowser("app://claude/chat", {
      height: 500,
      parent: "1",
      width: 800,
      x: 10,
      y: 20,
    });
    fake.openBrowser("app://claude/find", {
      height: 40,
      parent: "1",
      width: 200,
      x: 600,
      y: 0,
    });

    const { container } = render(
      <PageViews
        domicile={fake.domicile}
        onReach={() => undefined}
        unclickable={false}
        window="1"
      />,
    );

    const views = drawn(container);
    expect([...views.keys()]).toEqual(["2", "3"]);
    const chat = views.get("2");
    expect(chat?.style.insetInlineStart).toBe("10px");
    expect(chat?.style.insetBlockStart).toBe("20px");
    expect(chat?.style.inlineSize).toBe("800px");
    expect(chat?.style.blockSize).toBe("500px");
    expect(chat?.style.visibility).toBe("");
  });

  it("draws only this window's views", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("app://claude/", { isApp: true });
    fake.openBrowser("app://slack/", { isApp: true });
    fake.openBrowser("app://slack/view", { parent: "2" });

    const { container } = render(
      <PageViews
        domicile={fake.domicile}
        onReach={() => undefined}
        unclickable={false}
        window="1"
      />,
    );

    expect(drawn(container).size).toBe(0);
  });

  it("keeps a hidden view's page but does not show it", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("app://claude/", { isApp: true });
    fake.openBrowser("app://claude/chat", { isHidden: true, parent: "1" });

    const { container } = render(
      <PageViews
        domicile={fake.domicile}
        onReach={() => undefined}
        unclickable={false}
        window="1"
      />,
    );

    expect(drawn(container).get("2")?.style.visibility).toBe("hidden");
  });

  it("follows the views as the app moves them, keeping each view's element", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("app://claude/", { isApp: true });
    fake.openBrowser("app://claude/chat", { parent: "1", width: 100 });
    const { container } = render(
      <PageViews
        domicile={fake.domicile}
        onReach={() => undefined}
        unclickable={false}
        window="1"
      />,
    );
    const before = drawn(container).get("2");

    act(() => {
      fake.set({
        browserWindows: (fake.host.browserWindows ?? []).map((window) =>
          window.id === "2" ? { ...window, width: 300 } : window,
        ),
      });
    });

    const after = drawn(container).get("2");
    // The engine reads `window` once, at insertion: a new element would be
    // refused the page.
    expect(after).toBe(before);
    expect(after?.style.inlineSize).toBe("300px");
  });

  it("drops a view the app takes out", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("app://claude/", { isApp: true });
    fake.openBrowser("app://claude/chat", { parent: "1" });
    const { container } = render(
      <PageViews
        domicile={fake.domicile}
        onReach={() => undefined}
        unclickable={false}
        window="1"
      />,
    );

    act(() => {
      fake.closeBrowser("2");
    });

    expect(drawn(container).size).toBe(0);
  });

  it("reports a click in a view as a reach, unless nothing can click it", () => {
    const fake = new FakeDomicileHost();
    fake.openBrowser("app://claude/", { isApp: true });
    fake.openBrowser("app://claude/chat", { parent: "1" });
    let reaches = 0;
    const onReach = () => {
      reaches += 1;
    };
    const { container, rerender } = render(
      <PageViews
        domicile={fake.domicile}
        onReach={onReach}
        unclickable={false}
        window="1"
      />,
    );

    drawn(container)
      .get("2")
      ?.dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
    expect(reaches).toBe(1);

    rerender(
      <PageViews
        domicile={fake.domicile}
        onReach={onReach}
        unclickable={true}
        window="1"
      />,
    );
    drawn(container)
      .get("2")
      ?.dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
    expect(reaches).toBe(1);
  });
});
