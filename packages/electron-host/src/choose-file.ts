#!/usr/bin/env bun
// Asks the desktop's file chooser portal once and prints its answer as JSON:
// how `chooseFileSync` blocks the host until the user answers.
// `choose-file.ts <bus address> '{"method":"OpenFile","title":"Open","options":{…}}'`.

import { sessionBus } from "dbus-next";

import { chooseFile } from "./desktop";
import type { ChooserMethod, ChooserOptions } from "./electron/dialog";

const [address = "", request = ""] = process.argv.slice(2);
const { method, options, title } = JSON.parse(request) as {
  method: ChooserMethod;
  title: string;
  options: ChooserOptions;
};
const bus = sessionBus({ busAddress: address });
try {
  process.stdout.write(
    JSON.stringify(await chooseFile(bus, method, title, options)),
  );
} finally {
  bus.disconnect();
}
