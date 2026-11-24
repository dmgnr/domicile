# Engine releases

How CI publishes prebuilt engines and how the flake picks one.

## Pinned engines

| File | Build | Made by |
|---|---|---|
| `engine-release.nix` | checked: DCHECKs on, no PGO | `engine.yml`, on the pull request that changes the fork |
| `engine-official.nix` | production: PGO, ThinLTO, no DCHECKs | `engine-release.yml`, nightly from `main` |
| `engine-pin.nix` | picks one of the two | hand-written |

- `engine-pin.nix` uses the official build only when it was built from the
  same series as the checked build. Between a merge that changes the fork and
  the next nightly, `main` runs the checked build.
- `/packages/domicile-engine/scripts/update-engine-release.sh` moves `engine-release.nix` to the newest
  release.

## Which Chromium ships

- `CHROMIUM_PIN` names a Chromium `main` revision, not a release branch.
  `CHROMIUM_VERSION` holds its version, which the website shows.
- A commit's engine is its pin plus `patches/` and `src/`: both builds of a
  series come from the same pin, and
  `packages/ci/tests/test-the-pinned-engine-is-this-series.sh` checks the
  pinned engine is this series.
- A newer Chromium arrives as a pull request that moves the pin
  ([Moving the pin](BUILD-MACHINE.md#moving-the-pin)). CI builds and tests it
  like any fork change.
- People get it with the next Domicile release: the distribution packages
  carry the engine inside `domicile`, and the flake pins it, so a package
  update or a flake update brings it.
- There is no fixed schedule for moving the pin, and no commitment on how fast
  a Chromium security fix ships. A fix reaches Domicile when the pin moves
  past it.

## Where they are published

- As GitHub releases in
  [`cprussin/domicile-builds`](https://github.com/cprussin/domicile-builds),
  not here, so people watching this repository hear only of real releases.
- `DOMICILE_BUILDS_REPO` overrides the repository.
- The publish steps need the secret `DOMICILE_BUILDS_TOKEN`: a fine-grained
  token with Contents read and write on that repository.
- Releases there are tagged on its default branch; the body names the
  Domicile commit.
- `builds-prune.yml` deletes builds older than a week each day, except what
  `main`, `stable`, a `release-*` tag or an open pull request pins. It also
  deletes the builds still published here after two days, with the same
  exceptions.

## Release names

- A release is tagged `engine-s<identity>`.
- The identity is a content hash of `CHROMIUM_PIN`, `patches/` and `src/`, the
  same value `engine-series-stamp.sh` uses.
- Commits that do not change the fork share a release and need no repin.
- The official build's tag is `engine-official-s<identity>`. Both builds name
  their tarball `domicile-engine-s<identity>-linux-x64.tar.zst`.

## Which build a tarball holds

The tarball's `PROVENANCE` says, from the build's `args.gn`:

```
build:           checked (is_official_build = false, dcheck_always_on = true)
```

`engine-release-package.sh` stops if `args.gn` is missing, matches neither
build, or disagrees with `DOMICILE_ENGINE_BUILD`.

## What a tarball leaves out

- **Symbol tables.** Every ELF is stripped with Chromium's `llvm-objcopy`;
  `chrome`'s alone is 248.5 MB. Dynamic symbols stay.
- **`locales/*.pak.info`.** Build metadata (70.9 MB); only the `.pak`s run.

Both stay in the build directory on `crux` (`$CHROMIUM/out/Release`).

## A fork change is one pull request

On a pull request that changes the series, `engine.yml`:

1. builds the release configuration,
2. publishes it,
3. pushes the regenerated `engine-release.nix` onto the branch.

| Script | Role |
|---|---|
| `.github/scripts/engine-release-needed.sh` | decides whether this run must publish a release |
| `.github/scripts/engine-release-repin.sh` | commits `engine-release.nix` onto the branch tip |
| `/packages/ci/tests/test-the-pinned-engine-is-this-series.sh` | checks the pinned engine matches the series; runs on `ubuntu-latest` |

- The engine's hash is known only after CI builds it, so CI writes
  `engine-release.nix` back instead of the author.
- The last check is red on a fork change until the engine job writes back.
  Red after that is a real failure.
- Force-pushing over the written-back commit is safe. The next run finds the
  release already published, skips the build, and writes the same file.
- `engine-release.yml` also publishes on an `engine-v*` tag.

## The official repin

`engine-release.yml` opens a pull request that updates `engine-official.nix`
(`.github/scripts/engine-official-repin.sh`), with auto-merge on.

It needs the repository secret `DOMICILE_WRITEBACK_TOKEN`. A pull request
opened by `GITHUB_TOKEN` starts no checks. The secret is a fine-grained personal access token:

- Repository access: `cprussin/domicile` only.
- Permissions: Contents, Pull requests and Workflows, read and write.
- The repository allows auto-merge (Settings → General → Pull Requests).

`engine.yml`'s write-back also uses this token when it is set, so its push
starts CI without an approval.
