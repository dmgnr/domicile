import { describe, expect, it } from "bun:test";
import { appDesktop } from "@domicile-desktop/sdk/desktop/app-desktop";
import {
  lockScreenReadouts,
  recordingHost,
} from "@domicile-desktop/test-support/lock-screen-readouts";

import { soundServer } from "./sound-server";

describe("on a lock screen", () => {
  it("sends only the recorded readouts", async () => {
    const { host, sent } = recordingHost();
    const failed = Promise.withResolvers<void>();
    const sound = soundServer(
      appDesktop(host),
      { reopenMs: 60_000, settleMs: 0, tickMs: 0 },
      () => {
        failed.resolve();
      },
    );

    const stop = sound.watch(() => undefined);
    await failed.promise;
    stop();
    await sound.setVolume("output:alsa_output.pci", 1);
    await sound.setMuted("output:alsa_output.pci", true);
    await sound.setMuted("output:alsa_output.pci", false);

    expect(sent).toEqual(lockScreenReadouts("system-audio"));
  });
});
