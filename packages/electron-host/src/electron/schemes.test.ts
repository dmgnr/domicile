import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RegisteredScheme } from "./schemes";
import { createSchemeRegistration } from "./schemes";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

class Refused extends Error {}

const setUp = (registered: RegisteredScheme[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), "electron-schemes-"));
  dirs.push(dir);
  mkdirSync(join(dir, "state/domicile"), { recursive: true });
  const recordPath = join(dir, "state/domicile/electron-schemes.json");
  const register = createSchemeRegistration({
    app: "claude",
    recordPath,
    refuse: (why) => {
      throw new Refused(why);
    },
    registered,
  });
  const kept = () => JSON.parse(readFileSync(recordPath, "utf8"));
  return { kept, recordPath, register };
};

describe(createSchemeRegistration, () => {
  it("takes schemes the engine registered with the privileges asked for", () => {
    const { register } = setUp([
      { privileges: ["standard", "secure", "supportFetchAPI"], scheme: "app" },
    ]);

    expect(() =>
      register([
        // `stream` isn't granted yet, so it holds nothing back.
        {
          privileges: { secure: true, standard: true, stream: true },
          scheme: "app",
        },
        { privileges: { secure: true }, scheme: "https" },
      ]),
    ).not.toThrow();
  });

  it("keeps a scheme the engine lacks for the next start, and refuses the app", () => {
    const { kept, register } = setUp();

    expect(() =>
      register([
        {
          privileges: { corsEnabled: true, secure: true, standard: true },
          scheme: "cowork-artifact",
        },
      ]),
    ).toThrow("registers cowork-artifact:");
    expect(kept()).toEqual({
      claude: [
        {
          privileges: ["standard", "secure", "corsEnabled"],
          scheme: "cowork-artifact",
        },
      ],
    });
  });

  it("keeps a privilege the engine lacks, beside those kept before", () => {
    const { kept, recordPath, register } = setUp([
      { privileges: ["standard"], scheme: "app" },
    ]);
    writeFileSync(
      recordPath,
      JSON.stringify({ claude: [{ privileges: ["standard"], scheme: "app" }] }),
    );
    expect(() =>
      register([
        { privileges: { secure: true, standard: true }, scheme: "app" },
      ]),
    ).toThrow(Refused);

    expect(kept()).toEqual({
      claude: [{ privileges: ["standard", "secure"], scheme: "app" }],
    });
  });

  it("keeps other apps' schemes", () => {
    const { kept, recordPath, register } = setUp();
    expect(() => register([{ scheme: "app" }])).toThrow(Refused);
    const other = createSchemeRegistration({
      app: "element",
      recordPath,
      refuse: (why) => {
        throw new Refused(why);
      },
      registered: [],
    });

    expect(() =>
      other([{ privileges: { standard: true }, scheme: "vector" }]),
    ).toThrow(Refused);

    expect(kept()).toEqual({
      claude: [{ privileges: [], scheme: "app" }],
      element: [{ privileges: ["standard"], scheme: "vector" }],
    });
  });

  it("refuses a scheme the engine keeps for itself, without keeping it", () => {
    const { recordPath, register } = setUp();

    expect(() => register([{ scheme: "chrome-extension" }])).toThrow(
      "keeps for itself",
    );
    expect(() => readFileSync(recordPath)).toThrow();
  });
});
