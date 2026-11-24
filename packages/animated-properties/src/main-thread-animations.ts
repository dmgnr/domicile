import type {
  Comment,
  Expression,
  Node,
  ObjectExpression,
  ObjectProperty,
} from "oxc-parser";
import { parseSync } from "oxc-parser";

/** A property that a transition or keyframe animates off the compositor. */
export type Finding = {
  line: number;
  property: string;
};

/**
 * The comment that allows a main-thread animation, followed by why it is
 * needed: `// main-thread animation: <reason>`.
 */
export const EXEMPTION = "main-thread animation:";

/**
 * Properties the compositor animates, properties that only step, and colors,
 * which repaint a small area without layout.
 */
const ALLOWED = new Set([
  "backdrop-filter",
  "background-color",
  "border-color",
  "clip-path",
  "color",
  "content-visibility",
  "display",
  "fill",
  "filter",
  "none",
  "opacity",
  "outline-color",
  "overlay",
  "rotate",
  "scale",
  "stroke",
  "transform",
  "translate",
  "visibility",
]);

const KEYFRAME_SELECTOR =
  /^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/;

/**
 * Finds every property `source`, a TypeScript module of Panda styles, animates
 * on the main thread: in a `transition` or `transitionProperty` value, or in a
 * keyframe's frames. Skips an entry, or a whole keyframe, under an
 * {@link EXEMPTION} comment.
 *
 * Throws on a `transition` value that is not a string, a concatenation of
 * strings or an object of them, and on an exemption with no reason.
 */
export const mainThreadAnimations = (
  source: string,
  fileName = "module.tsx",
): Finding[] => {
  const parsed = parseSync(fileName, source);
  if (parsed.errors.length > 0) {
    throw new Error(
      `cannot parse ${fileName}: ${parsed.errors.map(({ message }) => message).join("; ")}`,
    );
  } else {
    const file = { comments: parsed.comments, source };
    return propertiesOf(parsed.program).flatMap((visited) =>
      exempt(file, visited.property) ||
      (visited.keyframe !== undefined && exempt(file, visited.keyframe))
        ? []
        : findingsOf(file, visited),
    );
  }
};

type File = { comments: readonly Comment[]; source: string };

/**
 * An object property, and if it is a frame, the keyframe it is one of. A frame
 * is visited twice: as a property, and as a frame.
 */
type Visited = {
  frame: boolean;
  keyframe: Spanned | undefined;
  property: ObjectProperty;
};

/** A node a comment can sit above. */
type Spanned = { start: number };

/** Every object property in `root`, depth first. */
const propertiesOf = (root: Node): Visited[] => {
  const visited: Visited[] = [];
  const walk = (node: unknown, parent: Spanned | undefined) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, parent);
      }
    } else if (typeof node === "object" && node !== null && "type" in node) {
      if (node.type === "Property") {
        visited.push({
          frame: false,
          keyframe: undefined,
          property: node as ObjectProperty,
        });
      } else if (node.type === "ObjectExpression") {
        const { properties } = node as ObjectExpression;
        if (properties.length > 0 && properties.every(isFrame)) {
          visited.push(
            ...properties.map((frame) => ({
              frame: true,
              keyframe: parent,
              property: frame as ObjectProperty,
            })),
          );
        }
      }
      const holder =
        node.type === "Property" || node.type === "VariableDeclaration"
          ? (node as Node)
          : parent;
      for (const [key, child] of Object.entries(node)) {
        if (key !== "parent") {
          walk(child, holder);
        }
      }
    }
  };
  walk(root, undefined);
  return visited;
};

const keyName = (property: ObjectProperty): string | undefined => {
  const { key } = property;
  if (key.type === "Identifier") {
    return key.name;
  } else if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  } else {
    return undefined;
  }
};

/** Whether `property` is a keyframe's frame, such as `"50%": { … }`. */
const isFrame = (property: ObjectExpression["properties"][number]): boolean =>
  property.type === "Property" &&
  KEYFRAME_SELECTOR.test(keyName(property) ?? "") &&
  property.value.type === "ObjectExpression";

/** What `property` animates off the compositor, if it is a transition or frame. */
const findingsOf = (file: File, { frame, property }: Visited): Finding[] => {
  const name = keyName(property);
  if (name === "transition" || name === "transitionProperty") {
    return valueStrings(file, property.value as Expression).flatMap(
      ({ line, text }) =>
        splitList(text)
          .map(propertyOf)
          .filter((animated) => !ALLOWED.has(animated))
          .map((animated) => ({ line, property: animated })),
    );
  } else if (frame && property.value.type === "ObjectExpression") {
    return property.value.properties.flatMap((set) => {
      const setName = set.type === "Property" ? keyName(set) : undefined;
      const animated = setName === undefined ? undefined : kebab(setName);
      return animated === undefined || ALLOWED.has(animated)
        ? []
        : [{ line: lineOf(file, set.start), property: animated }];
    });
  } else {
    return [];
  }
};

/**
 * The strings a transition value is made of: a string, strings joined with
 * `+`, an object of them, such as `{ base: …, _hover: … }`, or a ternary.
 */
const valueStrings = (
  file: File,
  value: Expression,
): { line: number; text: string }[] => {
  const line = lineOf(file, value.start);
  if (value.type === "Literal" && typeof value.value === "string") {
    return [{ line, text: value.value }];
  } else if (
    value.type === "TemplateLiteral" &&
    value.expressions.length === 0
  ) {
    return [
      { line, text: value.quasis.map(({ value: { raw } }) => raw).join("") },
    ];
  } else if (value.type === "BinaryExpression" && value.operator === "+") {
    return [
      {
        line,
        text: [
          ...valueStrings(file, value.left as Expression),
          ...valueStrings(file, value.right),
        ]
          .map(({ text }) => text)
          .join(""),
      },
    ];
  } else if (value.type === "ObjectExpression") {
    return value.properties.flatMap((condition) =>
      condition.type === "Property"
        ? valueStrings(file, condition.value as Expression)
        : unreadable(file, condition.start),
    );
  } else if (value.type === "ConditionalExpression") {
    return [
      ...valueStrings(file, value.consequent),
      ...valueStrings(file, value.alternate),
    ];
  } else {
    return unreadable(file, value.start);
  }
};

const unreadable = (file: File, at: number): never => {
  throw new Error(
    `line ${String(lineOf(file, at))}: cannot read the transition \`${file.source.slice(at, at + 40)}\``,
  );
};

/** Splits a comma-separated list, leaving commas inside parentheses. */
const splitList = (value: string): string[] => {
  const items: string[] = [];
  let depth = 0;
  let item = "";
  for (const character of value) {
    if (character === "," && depth === 0) {
      items.push(item);
      item = "";
    } else {
      depth += nesting(character);
      item += character;
    }
  }
  return [...items, item].filter((entry) => entry.trim() !== "");
};

/** How far `character` moves the parenthesis depth. */
const nesting = (character: string): number => {
  switch (character) {
    case "(":
      return 1;
    case ")":
      return -1;
    default:
      return 0;
  }
};

/**
 * The property a transition item names. An item that starts with a time names
 * none, which transitions `all`.
 */
const propertyOf = (item: string): string => {
  const first = item.trim().split(/\s+/)[0] as string;
  return /^[\d.{]/.test(first) ? "all" : first;
};

const kebab = (name: string): string =>
  name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const lineOf = (file: File, at: number): number =>
  file.source.slice(0, at).split("\n").length;

/**
 * Whether a comment in the run of comments just above `property` exempts it.
 * Throws on an exemption with no reason.
 */
const exempt = (file: File, property: Spanned): boolean =>
  leadingComments(file, property.start).some(({ value }) => {
    const at = value.indexOf(EXEMPTION);
    if (at === -1) {
      return false;
    } else if (value.slice(at + EXEMPTION.length).trim() === "") {
      throw new Error(
        `line ${String(lineOf(file, property.start))}: "${EXEMPTION}" needs a reason`,
      );
    } else {
      return true;
    }
  });

/** The comments separated from `start` by nothing but space and each other. */
const leadingComments = (file: File, start: number): Comment[] => {
  const leading: Comment[] = [];
  let end = start;
  for (const comment of file.comments.toReversed()) {
    if (
      comment.end <= end &&
      file.source.slice(comment.end, end).trim() === ""
    ) {
      leading.push(comment);
      end = comment.start;
    } else if (comment.end <= end) {
      break;
    }
  }
  return leading;
};
