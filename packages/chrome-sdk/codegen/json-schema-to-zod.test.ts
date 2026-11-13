import { describe, expect, it } from "bun:test";

import type { JsonSchema } from "./json-schema";
import { jsonSchemaToZod } from "./json-schema-to-zod";

const HEADER = ["Generated."];

const emit = (
  root: JsonSchema,
  defs: Readonly<Record<string, JsonSchema>> = {},
): string =>
  jsonSchemaToZod(
    { ...root, $defs: defs, title: "Config" },
    { header: HEADER },
  );

/** The Zod schema `schema` emits, as the root's only property. */
const schemaOf = (schema: JsonSchema): string => {
  const emitted = emit({
    properties: { value: schema },
    required: ["value"],
    type: "object",
  });
  const match = /^ {2}value: (.*),\n\}\);/ms.exec(emitted);
  if (match?.[1] === undefined) {
    throw new Error(`no property in ${emitted}`);
  } else {
    return match[1];
  }
};

describe("jsonSchemaToZod", () => {
  it("starts with the header and imports Zod", () => {
    expect(emit({ type: "object" })).toStartWith(
      '// Generated.\n\nimport { z } from "zod";\n',
    );
  });

  it("closes an object, filling an unset property from its default", () => {
    expect(
      emit({
        description: "The config.",
        properties: {
          name: { type: "string" },
          size: { default: 1, type: "integer" },
        },
        required: ["name"],
        type: "object",
      }),
    ).toContain(`/** The config. */
export const configSchema = z.strictObject({
  name: z.string(),
  size: z.number().int().prefault(1),
});`);
  });

  it("reads null and an unset nullable property as undefined", () => {
    expect(
      emit({
        properties: { name: { default: null, type: ["string", "null"] } },
        type: "object",
      }),
    ).toContain(
      "name: z.string().nullish().transform((value) => value ?? undefined),",
    );
    expect(
      schemaOf({ anyOf: [{ $ref: "#/$defs/Mode" }, { type: "null" }] }),
    ).toBe("modeSchema.nullish().transform((value) => value ?? undefined)");
  });

  it("throws on an optional property with no default to fill in", () => {
    expect(() =>
      emit({ properties: { name: { type: "string" } }, type: "object" }),
    ).toThrow("name");
  });

  it("emits each definition before the schemas that use it", () => {
    expect(
      emit(
        {
          properties: { pair: { $ref: "#/$defs/Pair" } },
          required: ["pair"],
          type: "object",
        },
        {
          Mode: { enum: ["dark", "light"], type: "string" },
          Pair: { prefixItems: [{ $ref: "#/$defs/Mode" }], type: "array" },
        },
      ),
    ).toEndWith(`export const modeSchema = z.enum(["dark", "light"]);

export const pairSchema = z.tuple([modeSchema]);

export const configSchema = z.strictObject({
  pair: pairSchema,
});
`);
  });

  it("checks the constraints the schema states", () => {
    expect(schemaOf({ maximum: 9, minimum: -1, type: "number" })).toBe(
      "z.number().min(-1).max(9)",
    );
    expect(schemaOf({ format: "uint32", minimum: 1, type: "integer" })).toBe(
      "z.number().int().min(1).max(4294967295)",
    );
    expect(() => schemaOf({ format: "uint8", type: "integer" })).toThrow(
      "uint8",
    );
    expect(schemaOf({ exclusiveMinimum: 0, type: "number" })).toBe(
      "z.number().gt(0)",
    );
    expect(schemaOf({ pattern: "^#[0-9a-f]{6}$", type: "string" })).toBe(
      'z.string().regex(new RegExp("^#[0-9a-f]{6}$"))',
    );
    expect(
      schemaOf({
        items: { type: "integer" },
        maxItems: 2,
        minItems: 2,
        type: "array",
      }),
    ).toBe("z.array(z.number().int()).min(2).max(2)");
  });

  it("emits maps, open objects, constants and unions", () => {
    expect(
      schemaOf({ additionalProperties: { type: "boolean" }, type: "object" }),
    ).toBe("z.record(z.string(), z.boolean())");
    expect(schemaOf({ additionalProperties: true, type: "object" })).toBe(
      "z.record(z.string(), z.unknown())",
    );
    expect(schemaOf({ const: "on", type: "string" })).toBe('z.literal("on")');
    expect(
      schemaOf({
        oneOf: [{ const: "on" }, { items: { type: "string" }, type: "array" }],
      }),
    ).toBe('z.union([z.literal("on"), z.array(z.string())])');
  });

  it("throws on a reference cycle, which it cannot order", () => {
    expect(() =>
      emit(
        { type: "object" },
        { Tree: { items: { $ref: "#/$defs/Tree" }, type: "array" } },
      ),
    ).toThrow("Tree");
  });
});
