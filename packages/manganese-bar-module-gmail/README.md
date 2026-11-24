# @domicile-desktop/manganese-bar-module-gmail

A manganese bar item: one Gmail account's inbox count, read with the Gmail
API. New mail raises a desktop notification.

## Use

Put `<Gmail />` in a column of
[`runManganese`](../shell-manganese/README.md)'s `bar`. No default bar has it.

```tsx
import { DEFAULT_BAR, runManganese } from "@domicile-desktop/manganese";
import { Gmail } from "@domicile-desktop/manganese-bar-module-gmail";

export const Shell = runManganese({
  bar: {
    ...DEFAULT_BAR,
    right: [
      <Gmail
        client={{ id: "….apps.googleusercontent.com", secret: "…" }}
        email="me@gmail.com"
        key="gmail"
        nickname="Work"
      />,
      ...DEFAULT_BAR.right,
    ],
  },
});
```

- `client`: a Google Cloud OAuth client, Desktop app type:
  1. Turn on the Gmail API in a Google Cloud project.
  2. Give the OAuth consent screen the `gmail.metadata`,
     `gmail.settings.basic` and `gmail.compose` scopes, and publish it.
     One in Testing expires sign-ins after 7 days.
  3. Create an OAuth client of the Desktop app type. Google does not treat
     its secret as secret.
- `email`: the Google account.
- `nickname`: its name on the bar.
- `profile`: the browser profile its Gmail window and sign-in open in, such
  as `"work"`. Without one, Gmail's site decides.

What it shows, and how it reads the inbox:
[TOP-BAR.md](../shell-manganese/docs/TOP-BAR.md#gmail).

## Test

```sh
bun run turbo test --filter @domicile-desktop/manganese-bar-module-gmail
```
