import { describe, expect, it } from "bun:test";

import { parseRootSchema } from "./json-schema";

const ROOT = {
  $defs: {},
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Config",
  type: "object",
};

describe("parseRootSchema", () => {
  it("keeps what types and constrains a value", () => {
    expect(
      parseRootSchema({
        ...ROOT,
        properties: {
          size: {
            exclusiveMinimum: 0,
            format: "uint16",
            maximum: 65_535,
            minimum: 0,
            type: "integer",
          },
        },
      }),
    ).toEqual({
      $defs: {},
      properties: {
        size: {
          exclusiveMinimum: 0,
          format: "uint16",
          maximum: 65_535,
          minimum: 0,
          type: "integer",
        },
      },
      title: "Config",
      type: "object",
    });
  });

  it("throws on a keyword it does not know, so no type is silently wrong", () => {
    expect(() =>
      parseRootSchema({
        ...ROOT,
        properties: { names: { patternProperties: {}, type: "object" } },
      }),
    ).toThrow("patternProperties");
  });

  it("keeps an object open to any key", () => {
    expect(
      parseRootSchema({
        ...ROOT,
        properties: { options: { additionalProperties: true, type: "object" } },
      }).properties,
    ).toEqual({ options: { additionalProperties: true, type: "object" } });
  });

  it("keeps a map whose values have a schema", () => {
    const map = {
      additionalProperties: { $ref: "#/$defs/Mode" },
      type: "object",
    } as const;
    expect(
      parseRootSchema({ ...ROOT, properties: { modes: map } }).properties,
    ).toEqual({ modes: map });
  });

  it("throws on an object open to other keys beside the ones it names", () => {
    expect(() =>
      parseRootSchema({
        ...ROOT,
        additionalProperties: true,
        properties: { name: { type: "string" } },
      }),
    ).toThrow("additionalProperties");
  });
});
