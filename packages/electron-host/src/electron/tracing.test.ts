import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContentTracing } from "./tracing";

describe(createContentTracing, () => {
  it("takes heap profiling, and a recording still holds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "electron-host-tracing-"));
    const tracing = createContentTracing(() => dir);

    await tracing.enableHeapProfiling();
    await tracing.startRecording({});
    const path = await tracing.stopRecording();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      traceEvents: [],
    });
  });
});
