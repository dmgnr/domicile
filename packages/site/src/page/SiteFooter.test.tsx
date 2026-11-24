import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SiteFooter } from "./SiteFooter";

test("every footer links the privacy policy and the terms", () => {
  const html = renderToStaticMarkup(<SiteFooter links={[]}>Hi</SiteFooter>);
  expect(html).toContain('href="/privacy"');
  expect(html).toContain('href="/terms"');
});
