// A Zod schema for a parsed JSON Schema: each definition becomes an exported
// `<name>Schema`, ordered before the schemas that use it, and the root one
// named by its title. A parse fills in every default, as serde does, and reads
// `null` as `undefined`.
//
// The output is unformatted; the caller runs a formatter over it.

import { jsDoc } from "./js-doc";
import type { JsonSchema, RootSchema, TypeName } from "./json-schema";

export type Options = {
  /** The file's leading comment, one line each. */
  readonly header: readonly string[];
};

const DEFINITION = "#/$defs/";

/** A property name JavaScript takes unquoted. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Reads `null`, as serde reads an `Option`, as unset. */
const UNSET_WHEN_NULL = ".nullish().transform((value) => value ?? undefined)";

export const jsonSchemaToZod = (
  { $defs, title, ...root }: RootSchema,
  options: Options,
): string =>
  [
    options.header.map((line) => `// ${line}`.trimEnd()).join("\n"),
    'import { z } from "zod";',
    ...ordered($defs).map((name) =>
      definition(name, definitionOf($defs, name)),
    ),
    definition(title, root),
  ]
    .join("\n\n")
    .concat("\n");

/** The definitions' names, each after the ones it refers to. */
const ordered = (
  $defs: Readonly<Record<string, JsonSchema>>,
): readonly string[] =>
  Object.keys($defs)
    .toSorted()
    .reduce<readonly string[]>(
      (done, name) => withUsed($defs, name, [], done),
      [],
    );

/** `done`, then what `name` refers to and `name`, unless already there. */
const withUsed = (
  $defs: Readonly<Record<string, JsonSchema>>,
  name: string,
  path: readonly string[],
  done: readonly string[],
): readonly string[] => {
  if (path.includes(name)) {
    throw new Error(`a reference cycle: ${[...path, name].join(" -> ")}`);
  } else if (done.includes(name)) {
    return done;
  } else {
    const used = references(definitionOf($defs, name)).reduce(
      (before, reference) =>
        withUsed($defs, reference, [...path, name], before),
      done,
    );
    return [...used, name];
  }
};

const definitionOf = (
  $defs: Readonly<Record<string, JsonSchema>>,
  name: string,
): JsonSchema => {
  const schema = $defs[name];
  if (schema === undefined) {
    throw new Error(`a reference to no definition: ${name}`);
  } else {
    return schema;
  }
};

/** The definitions `schema` refers to, anywhere inside it. */
const references = (schema: JsonSchema): readonly string[] => [
  ...(schema.$ref === undefined ? [] : [reference(schema.$ref)]),
  ...[
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.prefixItems ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(schema.additionalProperties === undefined ||
    schema.additionalProperties === true
      ? []
      : [schema.additionalProperties]),
  ].flatMap(references),
];

const definition = (name: string, schema: JsonSchema): string =>
  `${jsDoc(schema.description?.split("\n") ?? [], "")}export const ${schemaName(name)} = ${zodOf(schema, "")};`;

const schemaName = (name: string): string =>
  `${name.charAt(0).toLowerCase()}${name.slice(1)}Schema`;

const reference = ($ref: string): string => {
  if ($ref.startsWith(DEFINITION)) {
    return $ref.slice(DEFINITION.length);
  } else {
    throw new Error(`a reference outside the definitions: ${$ref}`);
  }
};

/** `schema`, reading `null` as unset if it allows it. */
const zodOf = (schema: JsonSchema, indent: string): string => {
  const variants = alternatives(schema, indent);
  const values = variants.filter((variant) => variant !== NULL);
  return values.length === variants.length
    ? union(values)
    : `${union(values)}${UNSET_WHEN_NULL}`;
};

const NULL = "z.null()";

const union = (variants: readonly string[]): string =>
  variants.length === 1
    ? variants.join("")
    : `z.union([${variants.join(", ")}])`;

/** The members of the union `schema` is, one for a schema that is not one. */
const alternatives = (
  schema: JsonSchema,
  indent: string,
): readonly string[] => {
  const variants = schema.oneOf ?? schema.anyOf;
  if (schema.$ref !== undefined) {
    return [schemaName(reference(schema.$ref))];
  } else if (schema.enum !== undefined) {
    return [
      `z.enum([${schema.enum.map((value) => JSON.stringify(value)).join(", ")}])`,
    ];
  } else if (schema.const !== undefined) {
    return [`z.literal(${JSON.stringify(schema.const)})`];
  } else if (variants !== undefined) {
    return variants.flatMap((variant) => alternatives(variant, indent));
  } else if (schema.type === undefined) {
    throw new Error(`no type in ${JSON.stringify(schema)}`);
  } else {
    return [schema.type].flat().map((type) => zodNamed(type, schema, indent));
  }
};

const zodNamed = (
  type: TypeName,
  schema: JsonSchema,
  indent: string,
): string => {
  switch (type) {
    case "array": {
      return arrayOf(schema, indent);
    }
    case "boolean": {
      return "z.boolean()";
    }
    case "integer": {
      return `z.number().int()${bounds(schema)}`;
    }
    case "null": {
      return NULL;
    }
    case "number": {
      return `z.number()${bounds(schema)}`;
    }
    case "object": {
      return objectOf(schema, indent);
    }
    case "string": {
      return schema.pattern === undefined
        ? "z.string()"
        : `z.string().regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
    }
  }
};

/**
 * A number's `minimum`, `exclusiveMinimum` and `maximum`, each bound it leaves
 * out taken from the range of the Rust type its `format` names.
 */
const bounds = (schema: JsonSchema): string => {
  const [least, most] = rangeOf(schema.format);
  const minimum = schema.minimum ?? least;
  const maximum = schema.maximum ?? most;
  return [
    minimum === undefined ? "" : `.min(${minimum})`,
    schema.exclusiveMinimum === undefined
      ? ""
      : `.gt(${schema.exclusiveMinimum})`,
    maximum === undefined ? "" : `.max(${maximum})`,
  ].join("");
};

/** The range of the Rust number type `format` names. */
const rangeOf = (
  format: string | undefined,
): readonly [number | undefined, number | undefined] => {
  switch (format) {
    case undefined:
    case "double": {
      return [undefined, undefined];
    }
    case "int32": {
      return [-(2 ** 31), 2 ** 31 - 1];
    }
    case "uint16": {
      return [0, 2 ** 16 - 1];
    }
    case "uint32": {
      return [0, 2 ** 32 - 1];
    }
    // Past `Number.MAX_SAFE_INTEGER`, so no upper bound a number can check.
    case "uint64": {
      return [0, undefined];
    }
    default: {
      throw new Error(`a number format with no known range: ${format}`);
    }
  }
};

const arrayOf = (schema: JsonSchema, indent: string): string => {
  if (schema.prefixItems !== undefined) {
    return `z.tuple([${schema.prefixItems.map((item) => zodOf(item, indent)).join(", ")}])`;
  } else if (schema.items === undefined) {
    throw new Error(`an array with no items in ${JSON.stringify(schema)}`);
  } else {
    return [
      `z.array(${zodOf(schema.items, indent)})`,
      schema.minItems === undefined ? "" : `.min(${schema.minItems})`,
      schema.maxItems === undefined ? "" : `.max(${schema.maxItems})`,
    ].join("");
  }
};

const objectOf = (schema: JsonSchema, indent: string): string => {
  if (schema.additionalProperties === undefined) {
    return closedObjectOf(schema, indent);
  } else if (schema.additionalProperties === true) {
    return "z.record(z.string(), z.unknown())";
  } else {
    return `z.record(z.string(), ${zodOf(schema.additionalProperties, indent)})`;
  }
};

const closedObjectOf = (schema: JsonSchema, indent: string): string => {
  const inner = `${indent}  `;
  const required = new Set(schema.required);
  const properties = Object.entries(schema.properties ?? {}).map(
    ([name, property]) =>
      `${inner}${propertyName(name)}: ${required.has(name) ? zodOf(property, inner) : unsetOf(name, property, inner)},\n`,
  );
  return properties.length === 0
    ? "z.strictObject({})"
    : `z.strictObject({\n${properties.join("")}${indent}})`;
};

/**
 * A property a config may leave out: its default when unset, or `undefined`
 * for one that allows `null`. Serde fills in every other one, so a schema that
 * gives it no default cannot say what a parse fills in.
 */
const unsetOf = (
  name: string,
  property: JsonSchema,
  indent: string,
): string => {
  const zod = zodOf(property, indent);
  if (zod.endsWith(UNSET_WHEN_NULL)) {
    return zod;
  } else if (property.default === undefined) {
    throw new Error(`no default for the optional property ${name}`);
  } else {
    return `${zod}.prefault(${JSON.stringify(property.default)})`;
  }
};

const propertyName = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);
