import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Carousel } from "./Carousel";

const render = () =>
  renderToStaticMarkup(
    <Carousel
      slides={[
        {
          caption: "The profile menu",
          key: "a",
          media: <img alt="" src="/a.png" />,
        },
        {
          caption: "Settings' Profiles page",
          key: "b",
          media: <img alt="" src="/b.png" />,
        },
      ]}
    />,
  );

test("shows every slide, each named by its place", () => {
  const html = render();
  expect(html).toContain('src="/a.png"');
  expect(html).toContain('src="/b.png"');
  expect(html).toContain('aria-label="1 of 2"');
  expect(html).toContain('aria-label="2 of 2"');
});

test("starts on the first slide, with its caption", () => {
  const html = render();
  expect(html).toContain("The profile menu");
  expect(html).not.toContain("Settings&#x27; Profiles page");
  expect(html).toMatch(
    /<button[^>]*aria-current="true"[^>]*aria-label="Show 1 of 2"/,
  );
});

test("can't go back from the first slide", () => {
  expect(render()).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous"/);
});
