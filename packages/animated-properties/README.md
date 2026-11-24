# @domicile-desktop/animated-properties

Fails on CSS transitions and keyframes that animate a property on the main
thread. Under a CPU cap, such as a laptop's power saver, those frames jank.

```sh
bun run turbo test:shell --filter=@domicile-desktop/animated-properties
```

- Reads every tracked `.ts` and `.tsx` file except tests: `transition` and
  `transitionProperty` values, and the frames of every keyframe.
- Allows what the compositor animates (`transform`, `translate`, `scale`,
  `rotate`, `opacity`, `filter`, `backdrop-filter`, `clip-path`), properties
  that only step (`display`, `visibility`, `overlay`), and colors, which repaint
  without layout.
- Fails on everything else, such as sizes, insets, margins, `box-shadow`,
  `z-index`, custom properties and `all`.
- A property that has to animate anyway gets a reason above it, or above its
  keyframe:

  ```ts
  // main-thread animation: opens to its content's height once.
  transition: "block-size {durations.normal} {easings.out}",
  ```

- `test:unit` covers the parser.
