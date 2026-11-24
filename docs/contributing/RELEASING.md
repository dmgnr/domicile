# Releasing

A release promotes `stable` to `release` and publishes every package version
it holds that is not published yet.

## Branches

- **`main`**: every merge publishes npm alphas, `0.0.0-alpha-<sha>`, under
  `next`.
- **`stable`**: the newest main that runs the official engine. Moves on its
  own (`stable.yml`).
- **`release`**: the newest release. Moves only through the release below.
- **`site`**: what domicile-desktop.com deploys: `release` plus site fixes
  picked from main ([below](#the-site)).

## Versions

Each package has its own version, set by changesets
([/.changeset/README.md](/.changeset/README.md)):

1. A pull request adds a changeset naming what it changes.
2. On main, `changesets.yml` keeps a "Version packages" pull request open
   that applies the pending changesets.
3. Merging it sets the versions. `stable` picks them up with the next official
   engine.

`domicile` is the distribution packages' version. A change to the Rust
crates, the engine or `packages/distro/` names it in its changeset.

## Release notes

Each release has an entry in two pages:

- [docs/RELEASE-NOTES.md](../RELEASE-NOTES.md): Domicile, for shell and app
  authors, under `domicile`'s version.
- [docs/use/RELEASE-NOTES.md](../use/RELEASE-NOTES.md): manganese, for its
  users, under `@domicile-desktop/manganese`'s version.

Every pull request adds to the next release's entry, or says it needs none
with a `Release-notes: none` trailer on one of its commits
(`.github/scripts/release-notes-required.sh`). Leave out what nobody would
miss: refactors, tests, CI, docs fixes.

The next release's entry says `_Unreleased_` under its heading while it
collects changes. Before cutting, date it on main. The site deploys `site`, so
the notes go live with the release; never pick them onto `site` early.

## Cutting a release

Run **Publish packages** (`publish-packages.yml`) with `release` checked:

1. Checks `stable`: ahead of `release`, `domicile` past 0.0.0, and dated
   [release notes](#release-notes) for its versions
   (`.github/scripts/release-check.sh`). Changesets not yet versioned wait
   for the next release, though a version published for the first time
   ships the code `stable` has, theirs included.
2. Builds the distribution packages at their versions and installs each in
   its distribution (`distro-packages.yml`).
3. Publishes to npm under `latest`.
4. Adds the packages to the signed apt, rpm and pacman repositories on R2
   (`release-repos.sh`, `packages/distro/repo.sh`).
5. Commits `domicile-bin` to the AUR (`release-aur.sh`, `packages/distro/aur.sh`).
6. Tags `<package>@<version>` for each new version and `release-<time>`, then
   moves `release` (`release-tag.sh`).
7. Moves `site` to the new `release` ([below](#the-site)).

`dry_run` is checked by default: it runs every step and publishes nothing.
Every step skips what is published already, so a failed release is run again
as it is.

A release of a commit whose dry run passed reuses that run's packages and
skips step 2 (`.github/scripts/release-dry-run.sh`), so run the dry run first.

A "Version packages" merge that changes nothing in the engine but its
`version` skips the engine build (`engine-proof.sh version-only`).

## Prereleases

Check `prerelease` too to publish `stable`, whose engine is the official,
optimized build, to the apt, rpm and pacman repositories and the AUR, for
testing the installs.
It skips npm (its alphas publish under `next` on every push), the tags and
`release`.

A prerelease of `domicile` `<version>` is `<version>~pre.<date>.<time>`, of
the commit, in UTC (`<version>pre.<date>.<time>` for pacman): every package
manager sorts it after the prereleases before it and before `<version>`, so
the release replaces it. The run refuses a `<version>` already released, as
its prerelease would sort before it; merge the "Version packages" pull request
first. The repositories keep three versions, prereleases included.

## The site

Vercel deploys domicile-desktop.com from `site`, so the docs describe the
released versions. To ship a site fix without a release, merge it to main,
then run **Site** (`site.yml`) with its main commit(s):

- Picks each onto `site` with `cherry-pick -x` (`.github/scripts/site-sync.sh`).
- Each release merges `release` onto `site`, picking again only the fixes the
  release lacks.
- Refuses a commit not on main, and a commit on `site` that is no pick.

Pick only commits that describe what is released.

## Protection

Two repository rulesets keep what a release published from moving:

- **`release` branch:** restrict deletions, block force pushes. The release
  only fast-forwards it.
- **Release tags** (`release-*`, `*@*`): restrict updates and deletions. The
  release only creates them.

## Secrets

| Name | Kind | What |
|---|---|---|
| `DOMICILE_SIGNING_KEY` | secret | The armored GPG key that signs the repositories. Backed up in `pass` with its revocation certificate. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | An R2 token that reads and writes the bucket. |
| `AUR_SSH_KEY` | secret | The AUR account's SSH key. |
| `R2_ACCOUNT_ID` | optional variable | Overrides the Cloudflare account. |
| `DOMICILE_R2_BUCKET` | optional variable | Overrides the bucket, `domicile-packages`. |
| `DOMICILE_REPO_URL` | optional variable | Overrides the bucket's public address, https://packages.domicile-desktop.com. |

npm needs none: it trusts `publish-packages.yml` by name, which is why the
release is in that workflow.
