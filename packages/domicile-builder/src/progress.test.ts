import { describe, expect, it } from "bun:test";

import { line, Step } from "./progress";

describe("line", () => {
  it("writes each step as the JSON `domicile` reads", () => {
    expect(line(Step.Resolving())).toBe('{"step":"resolving"}');
    expect(line(Step.Installing(["zod"]))).toBe(
      '{"packages":["zod"],"step":"installing"}',
    );
    expect(line(Step.Bundling())).toBe('{"step":"bundling"}');
    expect(line(Step.Built("/c/k", "shell.js", true))).toBe(
      '{"cached":true,"module":"shell.js","root":"/c/k","step":"built"}',
    );
    expect(line(Step.Evaluated("/c/k.json", false))).toBe(
      '{"cached":false,"config":"/c/k.json","step":"evaluated"}',
    );
    expect(line(Step.Serving("/run/d.sock", "domicile-dev-shell.js"))).toBe(
      '{"module":"domicile-dev-shell.js","socket":"/run/d.sock","step":"serving"}',
    );
    expect(line(Step.Failed("no"))).toBe('{"step":"failed","why":"no"}');
  });
});
