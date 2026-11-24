# Styling

The styling system, conventions, and mandates that apply to every package
in this repo.

## Mandates

- **All packages building UI MUST use [Panda CSS](https://panda-css.com).**
  No StyleX, CSS modules, scoped-CSS files, Tailwind, or any other styling
  system. Styles live in `.tsx` / `.ts` next to the component that uses
  them.
- **All packages MUST extend the `@domicile-desktop/component-library` Panda preset.**
  It defines the design tokens (semantic colors, spacing scale, typography,
  durations, easings, shadows, z-indices, opacities, keyframes) and the
  shared `control` recipe used by sized form controls. Theming flows from
  this preset; no package defines its own competing tokens.
- **All packages MUST use components from `@domicile-desktop/component-library` where
  possible** — `Button`, `Input`, `Textarea`, `Field`, `Avatar`, `Kbd`,
  `ModalDialog`, etc. Build app-specific UI on top of those primitives
  instead of rolling new buttons / inputs / dialogs from raw HTML. If a
  primitive is missing from the library, add it to the library and consume
  it — don't fork.

**One package is exempt, deliberately:
[`@domicile-desktop/shell-simple`](/packages/shell-simple/README.md).** It exists to be
the smallest usable React shell — the thing somebody writing a desktop outside
this repo reads to see what a shell is made of — and a design system is exactly
what that has to be legible without. It uses plain CSS in one stylesheet and
takes no dependency on the component library. Nothing else may claim this
exemption: a package with a product UI is not a worked example.

## Setup for a new package

1. Add the catalog dependencies to the package's `devDependencies`
   (`@pandacss/dev`, `postcss`) and to its `dependencies`
   (`@domicile-desktop/component-library` as `workspace:*`).
2. Create `panda.config.ts`:
   ```ts
   import { defineConfig } from "@pandacss/dev";
   import { domicilePreset } from "@domicile-desktop/component-library/pandacss-preset";

   export default defineConfig({
     exclude: [],
     hash: true,
     include: ["./src/**/*.{ts,tsx}"],
     jsxFramework: "react",
     outdir: "styled-system",
     preflight: true,
     presets: [domicilePreset],
   });
   ```
   An **app** — the package that actually ships a CSS bundle — must also
   `include` the sources of every package it renders, the component library
   first among them:
   ```ts
   include: [
     "./src/**/*.{ts,tsx}",
     "../../packages/component-library/src/**/*.{ts,tsx}",
   ],
   ```
   `css()` only produces class names; the build that *scans* a call site is
   what emits the matching rule, so a library component rendered by an app
   whose config never scanned it comes out styled by nothing. `hash: true` is
   what makes this safe: hashing is deterministic for a given preset, so the
   class names the library's own `styled-system` produces at runtime are the
   same ones the app's build emitted rules for. Keep it on in every config.
3. Wire the PostCSS plugin to your bundler. For Vite-based apps, add the
   plugin in `vite.config.ts`:
   ```ts
   import pandacssPostcssPlugin from "@pandacss/dev/postcss";
   import { defineConfig } from "vite";

   export default defineConfig({
     css: { postcss: { plugins: [pandacssPostcssPlugin] } },
     // ... rest of config
   });
   ```
4. Add the layer declaration to the package's entry CSS file (and import
   it from the package's entry point):
   ```css
   @layer reset, base, tokens, recipes, utilities;
   ```
5. Add a `prepare` script to `package.json`:
   `"prepare": "panda codegen --silent"`. The turbo `prepare` task runs
   automatically as a dependency of `build` / `test:types` / `test:unit`.
6. `styled-system/` is already covered by the root `.gitignore`.

## Import paths

All styling imports come from the local generated `styled-system/...`:

```tsx
import { css, cva, cx } from "../../styled-system/css";
import { flex, hstack, center } from "../../styled-system/patterns";
```

Adjust the relative path to match your source layout (consumers of the
component library should resolve their *own* generated `styled-system`,
not the library's — each package's Panda config emits its own CSS bundle
keyed off the same preset).

## Panda's static extractor — the #1 source of bugs

Panda extracts styles at build time by reading literal values inside calls
to its runtime helpers (`css`, `cva`, patterns). Values it can't resolve
statically produce class names with **no CSS rule attached** — the element
gets a class but the property silently doesn't apply.

The extractor canNOT trace into:

- **Helper return values consumed by Panda functions.**
  `cva({ base: wrapperBase })` where `wrapperBase` is an object exported
  from another file → opaque. Same for `flex(myHelper())`,
  `compoundVariants: someHelper()`. Fix: publish shared styles as a
  `css(...)` className and compose with `cx(...)`, or inline the literal
  at the call site.
- **Runtime construction.** `compoundVariants: SIZES.map((size) => ({ ...,
  css: { foo: TABLE[size] } }))` → opaque. Fix: write out the literal
  array entries.
- **Cross-file const lookups in consumer cvas.** `paddingInline:
  CONSTANTS[size]` inside a consumer `cva` → risky. The preset's
  `defineRecipe` *does* evaluate these (the preset is fully loaded at
  Panda's build time), but consumer cvas don't. Prefer inlined literals
  in consumer cvas, with a comment linking back to the source table.

What the extractor handles reliably:

- Object literals passed directly: `css({ color: "foreground" })`,
  `cva({ variants: { size: { md: { padding: 4 } } } })`.
- Ternaries with literal branches:
  `paddingBlockStart: title === undefined ? 10 : 2`.
- Pattern `.raw()` composition anywhere inside a cva object — `base`,
  `variants`, or `compoundVariants`:
  `size: { md: circle.raw({ size: 12 }) }`,
  `base: center.raw({ inset: 0 })`. See "Composing patterns with `cva`"
  below for when to reach for it.

When a property mysteriously stops applying, suspect the extractor first.
Inspect the element — if you see the expected class (`pbs_10`, `bd_muted`,
…) but no matching CSS rule in the bundle, it's an extraction failure.

## Tokens are required

Hardcoded literal values (px/rem dimensions, em letter-spacing, hex/rgb
colors, raw shadows, easing functions, etc.) are **not permitted** in
styles. Every numeric, color, and timing value must resolve through a
Panda token. The two narrow exceptions:

- **Border-width-related calculations.** Use the literal string `"1px"`
  when referring to a wrapper's 1px border — this matches how the border
  is declared (`border: "1px solid {colors.border}"`) and makes the
  connection obvious. Negative compensations like `marginBlock: "-1px"`
  follow the same rule.
- **CSS keywords with no token equivalent** — `"none"`, `"auto"`,
  `"transparent"`, `0`, `"100%"`, `"inline-flex"`, etc. — are fine as
  literals.

In every other case, find or add a token (and prefer finding to adding).

### Spacing

Use bare numbers for spacing values: `paddingBlock: 1.5`,
`marginInlineEnd: -2`. The domicile preset extends the default Panda scale
with every quarter-step from `0` through `1000` (`0.25`, `0.5`, `0.75`,
…, `1000`), each resolving to `step × 0.25rem`. There is no need to use
rem literals for spacing; if a fractional value looks unusual
(`paddingBlock: 2.75`), that's correct as long as the math works.

Use the same numeric values for `inset*`, `inlineSize` / `blockSize`,
`gap`, etc. — they all read from the spacing scale.

For hardcoded non-token sizing values (rare), use **rem**, not px. E.g.
`lineHeight: "1.125rem"`. The exception is the 1px border above.

### Colors — derive, don't add

Stick to the **semantic** color tokens defined by the domicile preset:

| Token | Use for |
|---|---|
| `foreground` / `background` | Primary text / surface |
| `muted` / `textTertiary` | De-emphasized text |
| `border` / `borderStrong` | Standard / emphasized borders |
| `card` | Card / elevated surface backgrounds |
| `accent` | Primary brand / focus / selection |
| `danger` / `warning` / `success` | Status colors |
| `onDanger` | Text on a `danger` fill |
| `private` | Marks a private browser window |
| `backdrop` | Modal/popover backdrop overlay |
| `skeleton` | Loading skeleton fills |
| `onPhoto` / `panelOverPhoto` | Lettering and a frosted panel drawn straight onto the wallpaper. The panel is dark enough that its text reads over a white page or wallpaper |
| `fillOverPhoto` | A bar button lit under the pointer or while its panel is open |
| `textSoft` / `textFaint` | A second line or figure / a section label, drawn from `currentcolor` |
| `fill` / `fillHover` / `divider` | A tile, row or card on a panel / under the pointer / a rule, drawn from `currentcolor` |

**Do not reach for the palette** (`colors.red.500`, etc.). The palette is
for the preset to derive semantic tokens *from* — not for consumer-side
usage.

**Do not introduce new semantic tokens lightly.** If you need a slightly
different shade of an existing semantic color (a hover color, a softer
variant, a tinted background), derive it inline with `color-mix(...)`
referencing the existing token:

```ts
backgroundColor: "color-mix(in oklab, {colors.foreground} 60%, {colors.background})",
borderColor: "color-mix(in oklab, {colors.danger} 70%, {colors.background})",
```

Panda's `{path}` placeholder substitution resolves token references
inside string values at build time. This is the pattern for all derived
hover, active, and tinted states.

Only promote a derived value to a new semantic token in the
`@domicile-desktop/component-library` preset (`pandacss-preset.ts`) when it is
**genuinely reusable across multiple components/apps** and represents a
distinct semantic role. Updating one site is not a reason to add a token.

### Light + dark themes

Every primitive semantic color in the domicile preset has both dark (`base`)
and light (`_light`) values. Setting `data-theme="light"` on `<html>`
flips the page to light mode via Panda's built-in `_light` condition;
no attribute (or any other value) leaves the page in dark mode, which
is the implicit default.

The primitive tokens are the only ones with per-theme values:
`foreground`, `background`, `accent`, `danger`, `private`, `success`,
`warning`.
Every derived token (`border`, `borderStrong`, `card`, `dangerSoft`,
`muted`, `skeleton`) resolves at CSS time through
`color-mix(... var(--colors-foreground), var(--colors-background))` —
when the foreground/background CSS variables flip, the derived tokens
recompute automatically. **Don't add `_light` overrides to derived
tokens** — let the math follow.

### Panels over the wallpaper

A panel over the wallpaper (`tone="overPhoto"` on `Popover` and `Tooltip`,
which set `data-tone="overPhoto"`) is dark in either theme. The preset's
`_onPhoto` condition gives everything inside it the dark theme's colors, so
components drawn in one, such as buttons, fields and cards, need nothing of
their own. `darkOverPhoto` in the preset adds it to every color token, and
declares each derived token again there: a custom property mixes the
variables where it is declared, so a mix declared only on `:root` would keep
the page's theme.

The rule is symmetric for consumers: any color you reach for must
resolve through a semantic token (or a `color-mix(...)` of one). A
literal palette reference like `{colors.neutral.900}` looks fine in
dark mode and breaks in light mode. If you find yourself wanting a
specific dark or light value, you almost always want the semantic
equivalent (`background`, `card`, `foreground`, …) instead.

### Panels

Popovers, drawers and the details drilled into from them are built from
the component library's panel parts, not hand-rolled rows and labels:

| Part | For |
|---|---|
| `Panel` | A titled panel; `PanelAction` puts a switch or button in its header |
| `PanelHeader` | A title, a back button, controls at the end |
| `PanelSection` | A group under a small label: Inboxes, Paired, Output |
| `List` / `ListRow` | A row: icon, label over a detail, something at the end. `plain` rows are choices; `filled` rows are tiles with their own buttons; `disclosure` folds details away |
| `DetailList` | Terms and values, such as addresses. Values can be selected; `copyable` rows get copy buttons; `address` rows wrap only between groups |
| `SliderRow` | A slider with its icon, value and an optional arrow |
| `EmptyState` | A panel or section with nothing to show: an icon, what is missing, what would fill it, and a button that would if there is one |
| `Loading` | What a panel waits for: a spinner over its words, what it searches for with rings spreading from it, or a spinner alone at a row's end |
| `PanelNote` | One line beside rows: nothing else nearby, or a refusal in plain words |
| `PanelFooter` | The last line: a summary and an action |
| `IconButton` | Every icon-only button |
| `ChoiceList` / `RadioRow` | A list to pick one from: where sound plays, a keymap |
| `QuickTile` | A quick settings tile into the details of what is nearly always on: Wi-Fi, Bluetooth |
| `QuickToggle` | A quick settings switch for what is turned on and off often: night light, dark mode |

Their type is the preset's `textStyles`: `panelTitle`, `panelLabel`,
`panelDetail` and `panelOverline`. A label and its detail differ in size and
color, not weight. Their colors are the `currentcolor` tokens above, so the
same parts read on a card, over the wallpaper and on an accent tile.

Sections sit `gap: 3` apart; a section's label and its rows `gap: 1`. A panel
never shows blank: while it waits, a `Loading`; with nothing to list, an
`EmptyState`, whose words say what is missing and what would fill it. The
two are the same height, so the panel holds still as one gives way to the
other; a panel searching for something, such as networks, gives `Loading`
that thing's `icon`. A button that starts the wait is `busy` until it ends.
Show a
refusal as a `PanelNote` with `tone="warning"`, saying what failed in plain
words, and pass the service's message as its `detail`.

### Other token categories

| Token category | Notes |
|---|---|
| `colors.<palette>.<step>` | Default Tailwind-style palette. **Preset only** — do not use directly. |
| `fontSize`, `fontWeight`, `letterSpacing`, `lineHeights` | Default Panda typography scales. `lineHeights.normal` (1.5), `lineHeights.tight` (1.25), etc. |
| `borderRadius` | Named scale: `xs`, `sm`, `md`, `lg`, `xl`, `2xl`, `3xl`, `4xl`, `full`. Per-size radii that aren't in this scale can be expressed by interpolating spacing tokens (e.g. `borderRadius: "{spacing.4}"`). |
| `shadows.md` | Default Panda shadow scale. |
| `gradients.scrimOverPhoto` | Domicile preset. A black-to-transparent scrim for a band of light text drawn over a photograph — the pair to `shadows.textOverPhoto`, which draws the letters while this darkens the ground under them. Give it a band deeper than the text's own row, or the ramp is at its thinnest exactly where the letters are. `backgroundImage` is not mapped to this category, so reference it by interpolation: `backgroundImage: "{gradients.scrimOverPhoto}"`. |
| `shadows.lifted`, `shadows.modal`, `shadows.textOverPhoto` | Domicile preset. `lifted` is a soft, broad drop shadow for floating surfaces — the `Select` popup is what uses it; `modal` is the heavier elevation used by dialogs. `textOverPhoto` is a *text* shadow — Panda reads `textShadow` out of this category — for light text drawn straight onto a photograph, which is what a shell's bar over its wallpaper is. |
| `borderWidths.fauxBold` | Domicile preset. A stroke width for bold that doesn't widen the text: `paintOrder: "stroke"` with `WebkitTextStroke: "{borderWidths.fauxBold} currentColor"`. For emphasis that must not shift the text around it, like a launcher row's matched letters. |
| `borderWidths.fauxMedium` | Domicile preset. As `fauxBold`, but about as heavy as a medium weight. For a heavier face that must not shift text as it comes and goes, like the title of the window being worked in. |
| `durations.fastest/faster/fast/normal/slow/slower/slowest/pulse` | Used in `transition` shorthands. |
| `durations.crossfade` | Domicile preset. A 2s dissolve between two pictures — far longer than the scale above, which measures how long a control takes to answer. |
| `durations.wipe` | Domicile preset. The 1.6s theme change wipe. |
| `easings.default/linear/in/out/in-out` | Used in `transition` shorthands. |
| `easings.emphasized`, `easings.outBack`, `easings.outQuart` | Domicile preset. `emphasized` is for long movements, such as a workspace switch; `outBack` is a back-out with a ~15% overshoot, for a landing that should bounce; `outQuart` is a settling ease-out for when `easings.out` reads too linear. |
| `opacity.disabled` (0.6), `opacity.dragging` (0.4), `opacity.pulseMin` (0.3) | Domicile preset. |
| `zIndex.modalBackdrop` / `zIndex.modal` | Domicile preset. Stacking for portaled overlays. |
| `fonts.mono` | Domicile preset. |
| Keyframes (`pulse`, etc.) | Defined in `pandacss-preset.ts`. Reference by name: `animationName: "pulse"`. **Never** define keyframes inline. |

## css vs cva vs sva

**All `css(...)` calls live after the component/function definition**,
not at the call site. Bind them to a named const and reference that const
from the JSX. Same rule as `cva` — the JSX shows *which* style is
applied, the definitions below show *what* the style is.

```tsx
// good — definitions live below
export const Thing = () => <div className={rootStyles}>…</div>;

const rootStyles = css({ padding: 4, color: "foreground" });

// avoid — inline css() at the call site
export const Thing = () => (
  <div className={css({ padding: 4, color: "foreground" })}>…</div>
);
```

Same rule applies to pattern helpers (`flex(...)`, `vstack(...)`,
`center(...)`, etc.) and to `cx(...)` compositions: hoist the result to a
named const declared after the component.

**Use `cva` for size/variant/state recipes** — anywhere you'd otherwise
switch on a prop to pick a style. Place cva blocks *after* the
component/function definition.

**Use `sva` (slot recipes) sparingly** — only when a component truly has
multiple slots that share variant logic. Most components don't need this;
a single cva plus a few named `css` consts is usually clearer.

When composing multiple class strings onto one element, join them with
`cx(...)`:

```tsx
className={cx(
  controlRecipe({ size }),
  wrapperStyles({ rounded, size }),
  iconStyles,
)}
```

Panda's atomic CSS deduplicates property-by-property at build time, so
the final order in the className doesn't need to mirror a precedence
ranking — last-write-wins within a single rule is enough.

### Sharing base styles across files

If multiple components need the same base style block, publish it as a
`css(...)` className (NOT a plain object) and compose with `cx(...)` at
each consumer. Example:

```ts
// shared/wrapperBase.ts
export const wrapperBase = css({ /* lots of selectors */ });

// consumer.tsx
className={cx(controlRecipe({ size }), wrapperBase, localStyles({ ... }))}
```

Consuming the const as `cva({ base: wrapperBase })` is opaque to the
extractor — the cross-file const reference produces classes with no CSS
rules in the bundle. The `css(...)` approach extracts at the declaration
site, so it's bulletproof.

## Prefer Panda patterns over hand-rolled css

Use the patterns from `styled-system/patterns` for layout primitives:

| Pattern | Replaces |
|---|---|
| `flex({ ... })` | `{ display: "flex", flexDirection, alignItems, justifyContent, ... }` |
| `center({ inline?: bool, ... })` | `{ display: flex/inline-flex, alignItems: center, justifyContent: center, ... }` |
| `hstack({ gap, justify, ... })` | flex row + items center + gap |
| `vstack({ gap, justify, ... })` | flex column + items center + gap |
| `stack({ direction, gap, ... })` | flex with direction + gap |
| `grid({ columns, gap, minChildWidth, ... })` | `{ display: "grid", ... }` |
| `circle({ size })` | a circular flex container of the given size |

The pattern handles `display` and the layout-related properties; pass
other properties through via rest props. Use `flex({ direction: "column",
gap: 4 })` instead of hand-writing `{ display: "flex", flexDirection:
"column", gap: 4 }`.

`vstack` and `hstack` set `align-items: center` by default — choose
`flex` when you want children to fill the cross axis (e.g. inputs in a
form field).

### Composing patterns with `cva` — prefer `.raw()` over `cx`

When a `cva` recipe needs the styles of a pattern (e.g. a `circle` whose
size varies per recipe variant), prefer composing inline via the
pattern's `.raw()` form rather than emitting a separate pattern className
and joining with `cx`. The `.raw()` form returns the pattern's style
object, which the cva can spread directly:

```ts
// preferred — single className, single rule set
const rootStyles = cva({
  variants: {
    size: {
      sm: circle.raw({ fontSize: "sm", size: 8 }),
      md: circle.raw({ fontSize: "md", size: 12 }),
    },
  },
});

// avoid — two className strings joined at the call site
className={cx(circle({ size: dim }), rootStyles({ size }))}
```

Embedding the pattern keeps the variant's full styling co-located,
avoids a parallel size-to-dimension table at the consumer, and produces
one className instead of two.

The same applies in cva `base`. If a pattern's layout is shared across
every variant, put it in `base` via `pattern.raw({...})` rather than
re-`.raw()`ing the same call in each variant:

```ts
const fallbackStyles = cva({
  base: center.raw({
    inset: 0,
    position: "absolute",
    transition: "opacity {durations.slowest} {easings.out}",
  }),
  variants: {
    visible: {
      false: { opacity: 0 },
      true: { opacity: 1 },
    },
  },
});
```

## Logical properties

Use logical properties throughout — `paddingInlineStart` instead of
`paddingLeft`, `insetBlockEnd` instead of `bottom`, `marginInline: "auto"`
instead of `marginLeft: "auto"`, `inlineSize` instead of `width`, etc.
Shorthands like `paddingBlock`, `paddingInline`, `marginBlock`, `inset`
are also fine.

Physical properties (`left`, `right`, `top`, `bottom`) are reserved for
the rare case where the orientation is intentionally physical (e.g. an
arrow that always points to the physical right). Document the reason
when you reach for a physical property.

## Shorthand

Prefer shorthand declarations: `border: "1px solid {colors.border}"`
over the three longhand properties, `transition: "opacity {durations.fast}
{easings.out}"` over three transition-* properties. The exception is
when you need different values per state (e.g. only `borderColor`
changes on hover) — then the longhand is fine.

## Numeric values

For spacing tokens, use bare numbers: `paddingBlock: 1.5`. Don't quote
them as strings.

For tokens that take string names (color, radii, easings, etc.), use the
string form: `color: "muted"`, `borderRadius: "lg"`.

For token interpolation inside string values (`color-mix`, `calc`,
multi-value shorthands), use `{path}` syntax: `"calc({spacing.8} - 2px)"`,
`"color-mix(in oklab, {colors.danger} 70%, {colors.background})"`.

## Conditions

Prefer Panda's built-in condition keys to writing raw selectors:

- `_hover`, `_focus`, `_focusVisible`, `_active`, `_disabled`, `_invalid`,
  `_loading`, `_starting`, `_open`, `_closed`, etc.
- These resolve to attribute-aware selectors. For example, `_loading`
  matches `:is([data-loading], [aria-busy=true])`, and `_disabled` matches
  `:is(:disabled, [data-disabled])`.

The domicile preset also defines `_activeEnabled` and `_hoverEnabled`
(active/hover but only when the element is also enabled), which is what
buttons use to avoid hover/active styles firing on a disabled control.
`_hoverOrOpen` matches hover or `[data-popup-open]`, so a bar button stays
lit while the panel it opened is open. `_controlHover` and `_controlActive`
match an element inside a button or link that is hovered or pressed, which is
what an animated icon's parts use.

`_contrastHigh` matches `theme.contrast: "high"` (`data-contrast="high"` on
`<html>`). Panda's own `_highContrast` matches forced colors instead.
`data-reduced-motion` on `<html>` shortens every animation and transition in
the preset's global CSS and drops their delays, so components need no
condition for it.

Use property-conditional shorthand:

```ts
backgroundColor: { base: "transparent", _hover: "card", _disabled: "card" }
```

Raw selectors (e.g. `&:has(...)`, `&[data-foo]`) are typed as
nested-block keys only:

```ts
{
  alignItems: "center",
  "&:has(input[data-invalid])": { borderColor: "danger" },
  "&[data-prefix-stack] [data-prefix-invalid]": { transform: "translateY(0)" },
}
```

Don't mix raw selectors into the property-conditional object — that's a
type error.

## data-* attributes as styling hooks

When a component needs to coordinate styling across multiple internal
elements based on state, use stable `data-*` attributes as the selector
target rather than relying on generated class names:

```tsx
<span data-prefix-stack="">
  <span data-prefix-decoration="">...</span>
  <span data-prefix-invalid="">...</span>
</span>
```

```ts
// In the wrapper cva:
"&:has(textarea[data-invalid]) [data-prefix-stack] [data-prefix-decoration]": {
  transform: "translateY(100%)",
},
```

## Animations and transitions

- Define all `@keyframes` in the package's Panda preset under
  `theme.extend.keyframes` (or rely on the keyframes defined in the domicile
  preset). Reference them by name from `css(...)` via
  `animationName: "pulse"`. **Never** define keyframes inline.
- Use the `transition` shorthand with `{durations.X} {easings.Y}` token
  interpolation: `transition: "opacity {durations.fast} {easings.default}"`.
- For base-ui Popup/Backdrop/Popover enter/exit animations, use the
  `&[data-starting-style]` and `&[data-ending-style]` selectors with
  `opacity` and `transform` transitions.
