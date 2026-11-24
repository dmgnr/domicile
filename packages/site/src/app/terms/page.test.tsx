import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import TermsPage, { metadata } from "./page";

const html = renderToStaticMarkup(<TermsPage />);

test("is its own canonical page", () => {
  expect(metadata.alternates?.canonical).toBe("/terms");
});

test("links the license the software ships under", () => {
  expect(html).toContain("/LICENSE");
});
