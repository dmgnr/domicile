#!/usr/bin/env bun
// Reads an app's safe storage password from the Secret Service, creating it
// the first time, and prints `{"password": …}` as JSON (null with no Secret
// Service): how `safeStoragePasswordSync` blocks the host until it has it.
// `safe-storage-password.ts <bus address> <application>`.

import { sessionBus } from "dbus-next";

import { readSafeStoragePassword } from "./secret-service";

const [address = "", application = ""] = process.argv.slice(2);
const bus = sessionBus({ busAddress: address });
try {
  const password = await readSafeStoragePassword(bus, application);
  process.stdout.write(JSON.stringify({ password: password ?? null }));
} finally {
  bus.disconnect();
}
