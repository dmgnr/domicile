# @domicile-desktop/site

domicile-desktop.com: the Domicile landing page for shell authors (`/`) and
the manganese landing page for its users (`/manganese`), and the docs
(`/docs/…`). A Next.js app,
hosted on Vercel and built from `site`: the latest Domicile release plus any
site fixes picked onto it ([RELEASING.md](/docs/contributing/RELEASING.md#the-site)).

```sh
bun run start:dev     # http://localhost:3000
bun run build:next
```

Without a checkout, build any ref and serve it on http://localhost:3000
(`PORT` to change), with that ref's unreleased release notes:

```sh
nix run github:cprussin/domicile/main#site-preview
```

- **Styling:** Panda CSS on the component library's preset, like every
  package. `Accent` sets `accent` to the product's color: violet for
  Domicile, the preset's cyan for manganese.
- **Code blocks:** highlighted at build time (`src/code/`).
- **Screenshots and videos:** `docs/media`, captured on crux by
  `packages/site/scripts/docs-media.sh`, served from R2 at
  `media.domicile-desktop.com` under each file's hash (`src/media/mediaUrl.ts`),
  so deployments don't carry them. A slot whose capture does not exist yet says
  what it will show. See [docs/media/README.md](/docs/media/README.md).
- **Matrix alias:** the site answers federation's lookup for
  `#domicile:domicile-desktop.com` (`src/matrix/`), so the alias needs no
  homeserver. The room lives on prussin.net.
- **Docs pages** render the repository's markdown at build time
  (`src/docs/`). `src/docs/pages.ts` lists which files the site renders,
  under which routes and sidebar sections. A link to one of them goes to its
  route; a link to any other file goes to it on GitHub. Headings get GitHub's
  ids, so anchors written for GitHub still land.

## Vercel

- Root directory: `packages/site`. `vercel.json` installs from the
  repository root, filtered to the site and the packages it uses, which runs
  their `prepare` (Panda codegen). It installs with the repository's bun
  (`packageManager`), since Vercel's own is older.
- The build builds the workspace packages the site uses first with turbo,
  since their exports point at `dist/`. The install filter includes the root
  (`./`) so turbo is installed.
- Production branch: `site` (set in the Vercel project).
- `git.deploymentEnabled` deploys only `site`. Even a skipped deployment
  counts toward the Hobby plan's daily limit, so other branches make none.
- `vercel-ignore.sh` skips every deployment but production, since each build
  costs. It logs what it decided at the top of the build log.
- Vercel also skips a `site` push that changes nothing under
  `packages/site` or its dependencies. To deploy without a site change, use
  **Redeploy** on the latest production deployment.
