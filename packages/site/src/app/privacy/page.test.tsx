import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import PrivacyPage, { metadata } from "./page";

const html = renderToStaticMarkup(<PrivacyPage />);

test("is its own canonical page", () => {
  expect(metadata.alternates?.canonical).toBe("/privacy");
});

test("names each Gmail scope the Gmail item asks Google for", () => {
  for (const scope of [
    "gmail.metadata",
    "gmail.settings.basic",
    "gmail.compose",
  ]) {
    expect(html).toContain(scope);
  }
});

test("carries Google's Limited Use disclosure", () => {
  expect(html).toContain(
    "https://developers.google.com/terms/api-services-user-data-policy",
  );
  expect(html).toContain("including the Limited Use requirements");
});

test("says how to take back Google access", () => {
  expect(html).toContain("https://myaccount.google.com/permissions");
});
