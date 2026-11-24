// TypeScript types for parsed WebIDL, as a page sees the objects: interfaces
// and dictionaries become object types, enums unions of their strings, and an
// `EventTarget`'s `on<name>` handlers an event map its listeners are typed by.
//
// The output is unformatted; the caller runs a formatter over it.

import { jsDoc } from "./js-doc";
import type {
  Idl,
  IdlArgument,
  IdlDictionary,
  IdlInterface,
  IdlOperation,
  IdlType,
} from "./parse-webidl";

const PRIMITIVES: Readonly<Record<string, string>> = {
  ByteString: "string",
  boolean: "boolean",
  byte: "number",
  DOMString: "string",
  double: "number",
  float: "number",
  long: "number",
  "long long": "number",
  octet: "number",
  short: "number",
  USVString: "string",
  "unrestricted double": "number",
  "unrestricted float": "number",
  "unsigned long": "number",
  "unsigned long long": "number",
  "unsigned short": "number",
};

/** Interfaces `lib.dom` declares, which the IDL takes by name. */
const PLATFORM_TYPES: ReadonlySet<string> = new Set(["DOMRectReadOnly"]);

/** Bases `lib.dom` declares. `EventTarget` is handled by `listeners`. */
const PLATFORM_BASES: ReadonlySet<string> = new Set(["Event", "EventInit"]);

/** The comment on a generated `addEventListener`. */
const LISTENER_DOC = [
  "Typed by the event map rather than by inheriting `EventTarget`, whose",
  "overloads take any name and type every listener's event as `Event`.",
  "`dispatchEvent` is left out: a page does not dispatch to it.",
];

export type Options = {
  /** The file's leading comment, one line each. */
  readonly header: readonly string[];
  /**
   * The event type each named event is dispatched as. The IDL types every
   * `on<name>` handler as `EventHandler`, so it cannot say. Others are `Event`.
   */
  readonly eventTypes: Readonly<Record<string, string>>;
};

export const webIdlToTypeScript = (idl: Idl, options: Options): string => {
  checkEventTypes(idl, options.eventTypes);
  const names = new Set([
    ...idl.enums.map((definition) => definition.name),
    ...idl.dictionaries.map((definition) => definition.name),
    ...idl.interfaces.map((definition) => definition.name),
  ]);
  const read = readDictionaries(idl);
  return [
    options.header.map((line) => `// ${line}`.trimEnd()).join("\n"),
    ...idl.enums.map(
      (definition) =>
        `${jsDoc(definition.doc, "")}export type ${definition.name} = ${definition.values.map((value) => JSON.stringify(value)).join(" | ")};`,
    ),
    ...idl.dictionaries.map((definition) =>
      dictionary(definition, read.has(definition.name), names),
    ),
    ...idl.interfaces.map((definition) =>
      interfaceType(definition, names, options.eventTypes),
    ),
  ]
    .join("\n\n")
    .concat("\n");
};

/** Every key of `eventTypes` must be an event the IDL fires. */
const checkEventTypes = (
  idl: Idl,
  eventTypes: Readonly<Record<string, string>>,
): void => {
  const fired = new Set(
    idl.interfaces.flatMap((definition) =>
      definition.events.map((event) => event.name),
    ),
  );
  const unknown = Object.keys(eventTypes).filter((name) => !fired.has(name));
  if (unknown.length > 0) {
    throw new Error(`no IDL interface fires ${unknown.join(", ")}`);
  }
};

/**
 * The dictionaries a page reads: those an operation returns, and those they
 * hold. The rest are passed in. One both read and passed has no single type.
 */
const readDictionaries = (idl: Idl): ReadonlySet<string> => {
  const dictionaries = new Map(
    idl.dictionaries.map((definition) => [definition.name, definition]),
  );
  const read = new Set<string>();
  const visit = (type: IdlType): void => {
    const definition = dictionaries.get(type.name);
    if (definition !== undefined && !read.has(type.name)) {
      read.add(type.name);
      for (const member of definition.members) {
        visit(member.type);
      }
    }
    for (const argument of type.arguments) {
      visit(argument);
    }
  };
  const operations = idl.interfaces.flatMap(
    (definition) => definition.operations,
  );
  for (const operation of operations) {
    visit(operation.returnType);
  }
  const passed = operations
    .flatMap((operation) => operation.arguments)
    .map((argument) => argument.type.name)
    .filter((name) => read.has(name));
  if (passed.length > 0) {
    throw new Error(`${passed.join(", ")} is both returned and passed`);
  } else {
    return read;
  }
};

const dictionary = (
  definition: IdlDictionary,
  read: boolean,
  names: ReadonlySet<string>,
): string => {
  const members = definition.members.map((member) => {
    const present = member.required || (read && member.defaulted);
    return `${jsDoc(member.doc, "  ")}  ${read ? "readonly " : ""}${member.name}${present ? "" : "?"}: ${typeScriptType(member.type, names)};`;
  });
  return `${jsDoc(definition.doc, "")}export type ${definition.name} = ${base(definition.inherits, names)}{\n${members.join("\n")}\n};`;
};

const interfaceType = (
  definition: IdlInterface,
  names: ReadonlySet<string>,
  eventTypes: Readonly<Record<string, string>>,
): string => {
  const isTarget = definition.inherits === "EventTarget";
  const eventMap = `${definition.name}EventMap`;
  const members = [
    ...mergeOverloads(definition.operations).map(
      (operation) =>
        `${jsDoc(operation.doc, "  ")}  ${operation.name}(${operation.arguments.map((argument) => `${argument.name}${argument.optional ? "?" : ""}: ${argument.types.map((type) => typeScriptType(type, names)).join(" | ")}`).join(", ")}): ${returnType(operation.returnType, names)};`,
    ),
    ...definition.attributes.map(
      (attribute) =>
        `${jsDoc(attribute.doc, "  ")}  readonly ${attribute.name}: ${typeScriptType(attribute.type, names)};`,
    ),
    ...(isTarget ? listeners(eventMap) : []),
  ];
  const type = `${jsDoc(definition.doc, "")}export type ${definition.name} = ${isTarget ? "" : base(definition.inherits, names)}{\n${members.join("\n")}\n};`;
  return isTarget
    ? `${eventMapType(definition, eventMap, eventTypes)}\n\n${type}`
    : type;
};

const eventMapType = (
  definition: IdlInterface,
  eventMap: string,
  eventTypes: Readonly<Record<string, string>>,
): string => {
  const events = definition.events.map(
    (event) =>
      `${jsDoc(event.doc, "  ")}  ${event.name}: ${eventTypes[event.name] ?? "Event"};`,
  );
  return `/** Every event \`${definition.name}\` fires, by name. */\nexport type ${eventMap} = {\n${events.join("\n")}\n};`;
};

/** `addEventListener` and `removeEventListener`, typed by the event map. */
const listeners = (eventMap: string): readonly string[] => [
  jsDoc(LISTENER_DOC, "  ").trimEnd(),
  ...["addEventListener", "removeEventListener"].map(
    (method) =>
      `  ${method}<T extends keyof ${eventMap}>(type: T, listener: (event: ${eventMap}[T]) => void): void;`,
  ),
];

type MergedArgument = {
  readonly name: string;
  readonly optional: boolean;
  readonly types: readonly IdlType[];
};

type MergedOperation = Omit<IdlOperation, "arguments"> & {
  readonly arguments: readonly MergedArgument[];
};

/** Overloads as one signature, each argument the union of its overloads'. */
const mergeOverloads = (
  operations: readonly IdlOperation[],
): readonly MergedOperation[] =>
  [...Map.groupBy(operations, (operation) => operation.name).values()].map(
    (overloads) => {
      const [first, ...rest] = overloads;
      if (first === undefined) {
        throw new Error("an operation group is empty");
      } else {
        return rest.reduce<MergedOperation>(
          (merged, overload) => mergeOverload(merged, overload),
          {
            ...first,
            arguments: first.arguments.map((argument) => ({
              name: argument.name,
              optional: argument.optional,
              types: [argument.type],
            })),
          },
        );
      }
    },
  );

const mergeOverload = (
  merged: MergedOperation,
  overload: IdlOperation,
): MergedOperation => {
  if (
    overload.arguments.length !== merged.arguments.length ||
    overload.returnType.name !== merged.returnType.name
  ) {
    throw new Error(
      `${merged.name}'s overloads differ in more than their argument types`,
    );
  } else {
    return {
      ...merged,
      arguments: merged.arguments.map((argument, index) => ({
        name: argument.name,
        optional: argument.optional,
        types: [...argument.types, ...argumentTypes(overload.arguments, index)],
      })),
      doc: [...merged.doc, "", ...overload.doc],
    };
  }
};

const argumentTypes = (
  args: readonly IdlArgument[],
  index: number,
): readonly IdlType[] => {
  const argument = args[index];
  return argument === undefined ? [] : [argument.type];
};

/** `Base & ` for a definition that inherits, or nothing. */
const base = (
  inherits: string | undefined,
  names: ReadonlySet<string>,
): string => {
  if (inherits === undefined) {
    return "";
  } else if (PLATFORM_BASES.has(inherits) || names.has(inherits)) {
    return `${inherits} & `;
  } else {
    throw new Error(`unknown base ${inherits}`);
  }
};

const returnType = (type: IdlType, names: ReadonlySet<string>): string =>
  type.name === "undefined" ? "void" : typeScriptType(type, names);

const typeScriptType = (type: IdlType, names: ReadonlySet<string>): string => {
  const inner = nonNullType(type, names);
  return type.nullable ? `${inner} | null` : inner;
};

const nonNullType = (type: IdlType, names: ReadonlySet<string>): string => {
  const [argument] = type.arguments;
  if (argument === undefined) {
    return namedType(type.name, names);
  } else {
    switch (type.name) {
      case "sequence":
      case "FrozenArray": {
        const element = typeScriptType(argument, names);
        return `readonly ${argument.nullable ? `(${element})` : element}[]`;
      }
      case "Promise": {
        return `Promise<${returnType(argument, names)}>`;
      }
      default: {
        throw new Error(`unknown generic type ${type.name}`);
      }
    }
  }
};

const namedType = (name: string, names: ReadonlySet<string>): string => {
  const primitive = PRIMITIVES[name];
  if (primitive !== undefined) {
    return primitive;
  } else if (names.has(name) || PLATFORM_TYPES.has(name)) {
    return name;
  } else {
    throw new Error(`unknown type ${name}`);
  }
};
