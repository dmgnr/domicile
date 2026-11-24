# @domicile-desktop/manganese-bar-module-sharing

Manganese bar items: the screen-sharing indicator, and the agents in control.

## Use

Put `<Sharing />` and `<Agents />` in a column of
[`runManganese`](../shell-manganese/README.md)'s `bar`:

```tsx
import { runManganese } from "@domicile-desktop/manganese";
import { Sharing } from "@domicile-desktop/manganese-bar-module-sharing";
import { Agents } from "@domicile-desktop/manganese-bar-module-sharing/agents";

export const Shell = runManganese({
  bar: {
    center: [],
    left: [],
    right: [<Sharing key="sharing" />, <Agents key="agents" />],
  },
});
```

Each takes no props. It reads `useDomicile()`. See
[TOP-BAR.md](../shell-manganese/docs/TOP-BAR.md).

## Test

```sh
bun run turbo test --filter @domicile-desktop/manganese-bar-module-sharing
```
