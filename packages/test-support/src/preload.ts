import { afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { registerAppElement } from "./app-element";
import { registerNodeInspection } from "./node-inspection";
import { registerSearchElement } from "./search-element";
import { registerSvgDataUrl } from "./svg-data-url";

// `register()` has to run before `@testing-library/jest-dom` and
// `@testing-library/react` load, because both access DOM globals when their
// modules evaluate. Static imports are hoisted above this call, so they are
// deferred to dynamic imports.
//
// Frames load but are not navigated: they point at `domicile://` pages that
// only the engine serves, and unit tests must not do I/O. happy-dom fails a
// frame with `error` unless frame loading is on.
GlobalRegistrator.register({
  settings: {
    enableIframePageLoading: true,
    navigation: { disableChildFrameNavigation: true },
  },
});

registerNodeInspection();
registerAppElement();
registerSearchElement();
registerSvgDataUrl();

const { default: _, ...matchers } = await import(
  "@testing-library/jest-dom/matchers"
);
const { cleanup } = await import("@testing-library/react");

expect.extend(matchers);

afterEach(cleanup);
