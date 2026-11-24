import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PAGES } from "../docs/pages";
import DomicilePage from "./page";

const html = renderToStaticMarkup(<DomicilePage />);

test("the page tells its story in order: the idea, why, what it makes possible, building, manganese, trying it, questions", () => {
  const sections = [...html.matchAll(/<section[^>]* id="([^"]+)"/g)].map(
    ([, id]) => id,
  );
  expect(sections).toEqual([
    "top",
    "why",
    "possible",
    "electron",
    "build",
    "make",
    "swap",
    "npm",
    "manganese",
    "batteries",
    "quickstart",
    "apps",
    "explore",
    "faq",
    "docs",
  ]);
});

test("every link on the page goes to a section or a docs page that exists", () => {
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id));
  const docs = new Set(PAGES.map((page) => `/docs/${page.slug}`));
  const broken = [...html.matchAll(/ href="([^"]+)"/g)]
    .map(([, href]) => href ?? "")
    .filter((href) =>
      href.startsWith("#")
        ? !ids.has(href.slice(1))
        : href.startsWith("/docs/") && !docs.has(href.split("#")[0] ?? ""),
    );
  expect(broken).toEqual([]);
});

test("the questions say the project is built with Claude", () => {
  const faq = html.slice(html.indexOf('id="faq"'), html.indexOf('id="docs"'));
  expect(faq).toContain("Was Domicile built with AI?");
  expect(faq).toContain("Claude");
});
