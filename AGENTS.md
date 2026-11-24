# AGENTS

Index of context files for this repo. Domicile is mixed-language, and both
languages share one package tree: `packages/*` holds the Rust crates that make
up the compositor and host (`domicile-*`) alongside the TypeScript libraries
for the chrome and the shell packages that use them (`shell-*`). A package is a
cargo crate or a bun workspace depending on whether it carries a `Cargo.toml`
or a `package.json`; `packages/domicile-engine` is neither, and holds the
Chromium pin and the patch series that make the fork. Each entry below is
tagged with an authority level so its weight is unambiguous.

## Authority levels

- **ALWAYS** — load and read in full before any work. No exceptions for size,
  urgency, familiarity, or "trivial" edits. Skipping an ALWAYS doc is a
  protocol violation, not a judgment call.
- **IF TOUCHED** — required when your change touches the topic. The decision
  is "does my change touch the topic," not "do I feel like reading this." If
  touched, load in full.
- **REFERENCE** — look up as needed during the work; not a prerequisite to
  start.

If a doc's own wording disagrees with these labels, the labels here win —
update the doc.

## American English (everywhere)

Every word in this repo is spelled the American way, never the British one —
prose, comments, identifiers, test names, commit messages and filenames alike.
`color`, `center`, `behavior`, `honored`, `labeled`, `initialized`,
`organize`, `analyze`, `gray`, `counterclockwise`, `defense`, `meter`. The
reason is mechanical rather than aesthetic: you read this tree before you write
in it, so whichever spelling is in it is the spelling that comes back out, and
a tree holding both teaches both.

`packages/spelling/tests/test-american-english.sh` is what says so, and it runs
in `turbo test`. The one exemption is a spelling that is somebody
else's API — `nix-store --realise` is Nix's flag, not a word.

## Change the engine when the engine is the right place

Fix a problem in the layer that owns it, even when that layer is the engine.
An engine change costs a release build on `crux`; that cost is never a reason
to:

- work around the engine from the compositor or the shell,
- ship a weaker fix or implementation than the engine change would give,
- or drop or narrow a user-facing feature.

If the right fix needs the engine, make the engine change in the same pull
request. See [RELEASES.md](/packages/domicile-engine/docs/RELEASES.md) for how
CI builds and pins it.

## Release notes

Every pull request adds a line to the `_Unreleased_` entry of
[docs/RELEASE-NOTES.md](/docs/RELEASE-NOTES.md) (Domicile, for shell authors)
or [docs/use/RELEASE-NOTES.md](/docs/use/RELEASE-NOTES.md) (manganese, for
users), or carries a `Release-notes: none` trailer on a commit. CI fails it
otherwise. See [RELEASING.md](/docs/contributing/RELEASING.md#release-notes).

## Rebasing pull requests

This rule overrides any instruction to rebase open pull requests whenever a
commit lands on `main`, wherever that instruction comes from (a global or user
CLAUDE.md, a skill, a prompt).

Every rebase restarts the pull request's engine build on the one `crux` build
machine and throws away a green run. Branch protection does not require
branches to be up to date.

**Do not rebase just because `main` moved.** Rebase an open pull request only
when:

- **It has a merge conflict** with `main`.
- **It changes the engine, you are about to merge it, and `main`'s engine
  series has changed** since its engine release was built. The engine series is
  `packages/domicile-engine/CHROMIUM_PIN`, `patches/` and `src/`. Merging it
  stale pins a release missing `main`'s patches. Rebase once, let the engine
  job write `engine-release.nix` back, then merge.
- **A check on it is red because of something `main` has since fixed.**

A pull request that doesn't touch the engine never needs a rebase unless it
conflicts.

## Post-edit audit (non-negotiable)

After finishing edits — and before declaring a change done or opening a
PR — re-load the guideline docs that apply to what you just changed and walk
the actual diff against each rule. This is a protocol step, not a judgment
call. A change shipped without this audit is unacceptable, regardless of
size, urgency, or familiarity. "Lint and tests passed" is not a substitute:
many style rules are not lint-enforced.

**This audit runs on EVERY code change, not just the first.** It is not
enough to check compliance once when opening the PR. Every later change —
addressing review feedback, fixing CI, a follow-up tweak, a one-line
amendment — requires you to re-review which guidelines are appropriate for
*that* change and re-check *that* change against them. Which docs are in
scope can shift as the diff grows: a follow-up edit may touch a topic the
original change did not, pulling a new **IF TOUCHED** doc into scope. Redo
the "which docs apply" determination from scratch for each change; do not
assume the earlier audit still covers you.

To decide *which* docs apply, re-read the authority labels below with your
diff in hand:

- Every **ALWAYS** doc is in scope.
- Every **IF TOUCHED** doc whose topic your change actually touches is in
  scope. Be honest about "touched": if you added or modified any `if`/`else`,
  you touched control flow; if you added a hook param for testability, you
  touched testing's dependency-injection rules; if you authored a component,
  you touched React and styling; if you edited a crate, you touched Rust; etc.
- Any per-package addenda (`{package}/docs/AGENTS.md`) for packages you
  modified are in scope.

Walk each rule in scope against your actual diff. Memory is not a substitute
for re-reading.

## PR description requirement

Every PR description MUST include an explicit "Guidelines audited" line
listing the docs reviewed and confirming the change complies. Example:

> **Guidelines audited:** `docs/guidelines/CONTROL_FLOW.md`,
> `docs/guidelines/ERRORS.md`, `docs/guidelines/TESTING.md`. Change complies
> with all rules.

If a rule deserves a note (intentional deviation, ambiguous case, etc.), call
it out below the line. A PR without this line is incomplete.

## ALWAYS (every change, no exceptions)

These apply to every change you make — bug fixes, one-line changes, refactors,
and "trivial" edits included. The language-agnostic ones (TESTING, ERRORS)
govern Rust as well as TypeScript; the rest are TypeScript rules that apply to
every TS file you write or modify.

| Doc | Covers |
|---|---|
| [/docs/guidelines/TESTING.md](/docs/guidelines/TESTING.md) | **TDD is mandatory.** Failing test first, then the minimum production code to make it pass. Parsimonious coverage, unit over integration, dependency injection over mocking, never widen exports for tests, warnings are failures. |
| [/docs/guidelines/ERRORS.md](/docs/guidelines/ERRORS.md) | **Code offensively** (PR-blocker): no defensive guards, no catch-and-swallow, no silent fallbacks; throw or return a `Result`. Promise error handling (never `void promise()`). |
| [/docs/guidelines/CONTROL_FLOW.md](/docs/guidelines/CONTROL_FLOW.md) | `undefined` over `null`, explicit `undefined` checks, curly braces always, explicit control flow, ternaries, no unnecessary `let`, `switch` over `if`/`else if`. |
| [/docs/guidelines/FUNCTIONS.md](/docs/guidelines/FUNCTIONS.md) | Functional/immutable/declarative defaults, arrow syntax, docstrings, manual loops over generators. |
| [/docs/guidelines/FILES.md](/docs/guidelines/FILES.md) | File/directory organization: top-to-bottom reading order, import from defining modules, no grab-bag names, prefer module-scoped functions. |
| [/docs/guidelines/WRITING.md](/docs/guidelines/WRITING.md) | How to write docs, READMEs, comments, Nix descriptions, commits and PRs: lead with the point, short direct sentences, bullets, no history or filler. |

## IF TOUCHED (load when your change touches the topic)

| Doc | Load when |
|---|---|
| [/docs/guidelines/RUST.md](/docs/guidelines/RUST.md) | You modify any crate in the cargo workspace (the `packages/domicile-*` packages). Workspace layout and the `default-members` split, required checks (`fmt`, `clippy -D warnings`, `test`), and the protocol crate's contract with the chrome SDK. |
| [/docs/guidelines/REACT.md](/docs/guidelines/REACT.md) | You author or modify a component, hook, or JSX. No `className`/`style` prop, Phosphor icon imports, wrapping `@base-ui/react`, the error-boundary contract, and never suppress `useExhaustiveDependencies`. |
| [/docs/guidelines/STYLING.md](/docs/guidelines/STYLING.md) | Any UI styling work. **Mandatory for any UI package.** Panda CSS is the only styling system; all packages extend the `@domicile-desktop/component-library` preset and use its components where possible. |
| [/docs/guidelines/APP_NAMES.md](/docs/guidelines/APP_NAMES.md) | You show a person an application (a window, a portal request, a notification, a holder). Name it from its desktop entry through `domicile_host::app_names` or `useApps`, never by its id. |
| [/docs/guidelines/ICONS.md](/docs/guidelines/ICONS.md) | You import a Phosphor icon. SSR path, `*Icon`-suffixed name, no barrel. |
| [/docs/guidelines/DATA.md](/docs/guidelines/DATA.md) | You read external data — host protocol frames, `JSON.parse`, `localStorage`, URL params, env vars. Never `as`-cast; parse with Zod. Versioning rules for contracts that cross deploy units, including the host↔chrome protocol. |
| [/docs/guidelines/DISCRIMINATED_UNIONS.md](/docs/guidelines/DISCRIMINATED_UNIONS.md) | You define or modify a discriminated union. Enum discriminant + PascalCase constructor object + type derived via `ReturnType`; the memory format always uses enums; map to wire strings in an explicit serializer/deserializer (Zod codec) at the boundary. |
| [/docs/guidelines/OPTION_RESULT.md](/docs/guidelines/OPTION_RESULT.md) | You design or modify a fallible API or a parser. When to return `Result<T, E>` / `Option<T>` from `@cprussin/option-result` instead of throwing or returning `undefined`, and how to work with them. |
| [/docs/guidelines/DESIGN_DOCS.md](/docs/guidelines/DESIGN_DOCS.md) | You author or modify a design doc in /docs/architecture/. Be concise and direct: lead with the answer, show don't describe, decisions not musings, cut filler and RFC ceremony. |

## REFERENCE

| Doc | Covers |
|---|---|
| [/docs/guidelines/WORKSPACE.md](/docs/guidelines/WORKSPACE.md) | Tools (bun, turbo, biome), workspace layout across both languages, package READMEs, dependency policy, and the required-checks workflow you run before a PR. |
| [/docs/contributing/DEVELOPING.md](/docs/contributing/DEVELOPING.md) | Running, testing and debugging from a checkout. Compositor debugging is in [COMPOSITOR-DEBUGGING.md](/docs/contributing/COMPOSITOR-DEBUGGING.md). |

## Architecture & design docs

These live in [`/docs/architecture/`](/docs/architecture/). They are context,
not rules, and carry no authority level. Read the one for the area you work in.

| Doc | Covers |
|---|---|
| [/docs/architecture/ARCHITECTURE.md](/docs/architecture/ARCHITECTURE.md) | What Domicile is (a Wayland compositor whose renderer is a web engine), the decisions that follow, and what each crate and package is for. Start here. |
| [/docs/architecture/WINDOW-COMPOSITING.md](/docs/architecture/WINDOW-COMPOSITING.md) | How a client's window reaches the screen: its dmabuf becomes a viz surface that the page's `<app>` embeds as a `cc::SurfaceLayer`. Open items at the bottom. |
| [/docs/architecture/STACKING-PARITY.md](/docs/architecture/STACKING-PARITY.md) | Routes to stacking windows among page elements without a fork, and the evidence that ruled each out. |
| [/docs/architecture/ENGINE-FORK.md](/docs/architecture/ENGINE-FORK.md) | The fork: `<app>` as a `SurfaceLayer`, the frame sink broker, the C ABI, buffer import, key decisions and the plan. |
| [/docs/architecture/ENGINE-FORK-MEASUREMENTS.md](/docs/architecture/ENGINE-FORK-MEASUREMENTS.md) | Evidence for the fork: spike pixel proofs, CSS parity tables, `<app>` vs OOPIF, producer latency, keystroke to pixel, client window guard, dmabuf import, shortcut-inhibitor guards. |
| [/docs/architecture/ENGINE-FORK-CHROMIUM-NOTES.md](/docs/architecture/ENGINE-FORK-CHROMIUM-NOTES.md) | Undocumented Chromium behavior: mojo invitations, Rust mojom crates vs cargo, Ozone platforms and dmabuf import, GPU library path on `crux`, `SurfaceLayerBridge` vs OOPIF. |
| [/docs/architecture/ENGINE-BROWSER-BEHAVIOR.md](/docs/architecture/ENGINE-BROWSER-BEHAVIOR.md) | Keys, clicks and gestures go to the shell; no password manager, autofill or WebAuthn UI; the host shortcut inhibitor when nested; the guards for each. |
| [/docs/architecture/DOMICILE-SCHEME.md](/docs/architecture/DOMICILE-SCHEME.md) | `domicile://shell/` and `domicile://home/`, the control-channel binding, and why there is no loopback port. |
| [/docs/architecture/THE-DOMICILE-BINARY.md](/docs/architecture/THE-DOMICILE-BINARY.md) | The `domicile` binary: modules, the home-manager module, crash recovery, finding components, the control socket and the engine command socket. |
| [/docs/architecture/A-DESKTOP-ON-A-TTY.md](/docs/architecture/A-DESKTOP-ON-A-TTY.md) | Running on a bare tty with Ozone DRM: building it, the embedder, DRM master, input, outputs, clipboard. Read before touching the DRM platform or `platform.rs`. |
| [/docs/architecture/A-HEADLESS-DESKTOP.md](/docs/architecture/A-HEADLESS-DESKTOP.md) | A desktop with no display device or seat (WSL2): virtual monitors resized in place, frames out through display capture, input in through EIS. The plan. |
| [/docs/architecture/ONE-PAGE-FOR-THE-DESK.md](/docs/architecture/ONE-PAGE-FOR-THE-DESK.md) | One shell page spanning every monitor on a tty, each at its own scale and refresh rate: presenters per CRTC and floats dragged across screens. |
| [/docs/architecture/DISPLAY-TILINGS.md](/docs/architecture/DISPLAY-TILINGS.md) | How cc keeps a tiling per monitor scale: regions, tilings, activation, raster order, draw, fallback, tile memory. |
| [/docs/architecture/EXTENSIONS.md](/docs/architecture/EXTENSIONS.md) | Chrome extensions: installed from the config, actions in the shell's tray, every `<webview>` a tab to `chrome.tabs`. |
| [/docs/architecture/SYSTEM-TRAY.md](/docs/architecture/SYSTEM-TRAY.md) | The compositor as StatusNotifierItem host; the shell draws the icons and their dbusmenu menus. |
| [/docs/architecture/NOTIFICATIONS.md](/docs/architecture/NOTIFICATIONS.md) | The compositor as the `org.freedesktop.Notifications` server for apps and sites; the shell toasts them and keeps a drawer. |
| [/docs/architecture/KEYBINDINGS.md](/docs/architecture/KEYBINDINGS.md) | A shell's keybindings as props: sway-style chords resolved against the compositor's keyboard layout and dispatched by the SDK. |
| [/docs/architecture/GESTURES.md](/docs/architecture/GESTURES.md) | Touchpad and touchscreen gestures: pinch to the window under the pointer, Meta+pinch to the desk, multi-finger gestures to the shell. The plan. |
| [/docs/architecture/WEB-APPS.md](/docs/architecture/WEB-APPS.md) | Web apps as desktop entries: `domicile open --app`, app windows without an address bar, and the plan for installing sites as apps. |
| [/docs/architecture/TEXT-INPUT.md](/docs/architecture/TEXT-INPUT.md) | Input methods (fcitx5, IBus) composing into native windows, pages and the shell through one relay per seat. The plan. |
| [/docs/architecture/COLOR.md](/docs/architecture/COLOR.md) | 10-bit client formats and scanout, `wp_color_management_v1`, and opt-in HDR per display on Chromium's color pipeline. The plan. |
| [/docs/architecture/APP-MODULES.md](/docs/architecture/APP-MODULES.md) | Apps as modules: `domicile open --app <entry.js>` calls `main(root, host)` on `domicile://app-<id>/`; History and Settings as app modules instead of extensions. |
| [/docs/architecture/ELECTRON-APPS.md](/docs/architecture/ELECTRON-APPS.md) | Electron apps on the engine: `electron-host` runs the main process with a stand-in `electron` module, windows are app windows, preload and IPC over the Electron socket. The plan. |
| [/docs/architecture/BROWSER-PROFILES.md](/docs/architecture/BROWSER-PROFILES.md) | Browser profiles: a Chrome profile per profile, sites mapped to profiles, moving a page between them. The plan. |
| [/docs/architecture/MOTION.md](/docs/architecture/MOTION.md) | Shader effects for shells (SkSL as a `filter` function run in viz) and the motion pass over manganese: springs, interruptible motion, per-surface changes. The plan. |

[`/docs/KNOWN-GAPS.md`](/docs/KNOWN-GAPS.md) lists known gaps, each pointing at the doc
with the detail. Read it before substantial work. Remove a gap when it's fixed.

## Guides

How to use, configure and debug Domicile. No authority level.

| Doc | Covers |
|---|---|
| [/docs/HOW-IT-WORKS.md](/docs/HOW-IT-WORKS.md) | The site's conceptual entry point: why the browser engine is the compositor, `<app>`, `<webview>`, extensions, building a desktop, measured and unmeasured performance. |
| [/docs/contributing/RELEASING.md](/docs/contributing/RELEASING.md) | Branches, per-package versions, cutting a release, its secrets. |
| [/docs/media/README.md](/docs/media/README.md) | Docs screenshots and videos: scenes, their helpers, retaking them on `crux`. |
| [/docs/RUNNING-A-DESKTOP.md](/docs/RUNNING-A-DESKTOP.md) | Running a desktop nested or on a tty, the pinned engine, launching clients, and the home-manager module. |
| [/docs/SHELL-CONFIG.md](/docs/SHELL-CONFIG.md) | The desk config: file location, config modules, the home-manager module, what reloads, and the keyboard, idle, lock, theme and display sections. |
| [/docs/HISTORY.md](/docs/HISTORY.md) | The History app: how visits are recorded, how every desktop installs and opens it, and Domicile's own launcher entries. |
| [/docs/SETTINGS.md](/docs/SETTINGS.md) | The Settings app: what it can change, the host it spawns, and how it lists site permissions. |
| [/docs/LAUNCHER.md](/docs/LAUNCHER.md) | Launcher config: `files.omit`, `applications.omit`, `X-Domicile-Preview`, bookmarks and their icons. |
| [/docs/WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md) | Writing a shell outside this repo. Read before changing anything a shell can see (module name, document, SDK surface). Example: `examples/minimal-shell`. |
| [/docs/SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md) | `<webview>` for shell authors: state properties and events, focus, keyboard, new windows, close requests, file pickers. |
| [/docs/SHELL-EXTENSIONS.md](/docs/SHELL-EXTENSIONS.md) | Extensions for shell authors: the extensions list, `extensions.activate`, popups, the tab/window mapping. |
| [/docs/SHELL-DESKTOP-EVENTS.md](/docs/SHELL-DESKTOP-EVENTS.md) | Desktop events for shell authors: displays, theme, system tray, notifications. |
| [/docs/PORTALS.md](/docs/PORTALS.md) | Domicile as the only `xdg-desktop-portal` backend: the request channel, the shell's dialogs, each interface and the decisions behind it. |
| [/docs/SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md) | Files, processes and D-Bus for shell authors: the page API, the system libraries, the wire and the security rules. |
| [/docs/SHELL-IDLE-AND-LOCK.md](/docs/SHELL-IDLE-AND-LOCK.md) | Idle and lock for shell authors: the idle message, what is blocked while locked, drawing a lock screen. |
| [/docs/SHELL-PACKAGING.md](/docs/SHELL-PACKAGING.md) | Packaging a shell: required Vite settings, inlined CSS, avoiding a theme flash, distributing, building with `domicile`. |
| [/docs/DISPLAYS.md](/docs/DISPLAYS.md) | Displays on a tty: display-list sources, profiles, which connectors light, pointer crossing, tablets, rotation, shell windows per CRTC, monitor names. |
| [/docs/CASTING-TO-TVS.md](/docs/CASTING-TO-TVS.md) | Casting to TVs: Google Cast in the engine, `domicile-miracast` for Miracast, Extend onto a virtual monitor or Cast… through the share picker. |
| [/docs/IDLE.md](/docs/IDLE.md) | Idle blanking, `HostMessage::Idle`, idle inhibitors, sleeping the monitors on demand, and log lines to check on hardware. |
| [/docs/LOCK.md](/docs/LOCK.md) | The screen lock: where it is enforced, request categories, ordering, verifiers, passphrase checks, fail-closed PAM, log lines. |
| [/docs/TTY-SESSION.md](/docs/TTY-SESSION.md) | DRM master, console switching through logind, suspend, and input from logind. |
| [/docs/LOGGING.md](/docs/LOGGING.md) | Where logs go: journal entries with priorities and a name per part, or plain lines on a terminal; reading them with `journalctl`. |
| [/docs/TTY-DEBUGGING.md](/docs/TTY-DEBUGGING.md) | Seeing a modeset in logs, black screens with a clean log, and hosts where scanout and render cards differ. |
| [/docs/contributing/COMPOSITOR-DEBUGGING.md](/docs/contributing/COMPOSITOR-DEBUGGING.md) | The compositor's frame report and slow-launch logs; rendering, Smithay and test-client pitfalls. |
| [/docs/HARDWARE-CHECKS.md](/docs/HARDWARE-CHECKS.md) | Steps and expected log lines for each check that needs a lit panel (suspend, console switch, crashes, idle, PAM lock, latency, several monitors). |

## Package docs

| Doc | Covers |
|---|---|
| [/packages/chrome-sdk/docs/ELEMENTS.md](/packages/chrome-sdk/docs/ELEMENTS.md) | `<app>` and `<webview>` for shells: sizing, the engine's pointer and keyboard forwarding, focus, context menu, popups, held modifiers. |
| [/packages/domicile-engine/docs/BUILDING-CHROMIUM.md](/packages/domicile-engine/docs/BUILDING-CHROMIUM.md) | A Chromium checkout from scratch, the gn args, pitfalls, and rolling the pin. |
| [/packages/domicile-engine/docs/BUILD-MACHINE.md](/packages/domicile-engine/docs/BUILD-MACHINE.md) | `crux`: the shared checkout and tree lock, the toolchain shell, moving the pin, the tree pool, build cost. |
| [/packages/domicile-engine/docs/RELEASES.md](/packages/domicile-engine/docs/RELEASES.md) | The pinned engines, release names, the write-back flow, `DOMICILE_WRITEBACK_TOKEN`. |
| [/packages/domicile-engine/docs/CONTROL-CHANNEL.md](/packages/domicile-engine/docs/CONTROL-CHANNEL.md) | `DomicileHost` members, typed values, adding a message or event, the command socket and dev reload. |
| [/packages/domicile-engine/docs/GUARDS.md](/packages/domicile-engine/docs/GUARDS.md) | One line per guard, helper and spike script in the engine package's `scripts/`, by area. |
| [/packages/domicile-engine/docs/SOURCE-MAP.md](/packages/domicile-engine/docs/SOURCE-MAP.md) | Where the surface-embedding code lives under `src/`. |
| [/packages/domicile-engine/docs/TESTING.md](/packages/domicile-engine/docs/TESTING.md) | Engine unit test suites, their filters and minimum counts, and the command that runs what CI runs. |
| [/packages/e2e-harness/docs/SCRIPT-VERDICTS.md](/packages/e2e-harness/docs/SCRIPT-VERDICTS.md) | Exit codes, `packages/e2e-harness/lib/harness.sh` helpers, required script structure, and the rules `src/verdicts.ts` enforces. |
| [/packages/manganese-window-management/docs/WINDOW-MANAGEMENT.md](/packages/manganese-window-management/docs/WINDOW-MANAGEMENT.md) | Layout tree, screens and workspaces, focus, pointer warping, dragging, title bars, animations. |
| [/packages/manganese-window-management/docs/FOCUS-INTERNALS.md](/packages/manganese-window-management/docs/FOCUS-INTERNALS.md) | How pointer warping, browser-window focus and modifier drags over clients work. |
| [/packages/manganese-window-management/docs/KEYS.md](/packages/manganese-window-management/docs/KEYS.md) | Default bindings, resize mode, commands, keysym rules, a sample config, differences from sway. |
| [/packages/shell-manganese/docs/TOP-BAR.md](/packages/shell-manganese/docs/TOP-BAR.md) | The `bar` option and its items: workspaces, clock, network, Bluetooth, battery, brightness, volume, notifications, tray. |
| [/packages/shell-manganese/docs/HOST-READOUTS.md](/packages/shell-manganese/docs/HOST-READOUTS.md) | How backlight and audio are read for the top bar. |
| [/packages/shell-manganese/docs/CUSTOM-BAR-ITEMS.md](/packages/shell-manganese/docs/CUSTOM-BAR-ITEMS.md) | Styling custom bar items. |
| [/packages/manganese-launcher/docs/LAUNCHER.md](/packages/manganese-launcher/docs/LAUNCHER.md) | Launcher row order, sources and previews. |
| [/packages/manganese-clipboard/docs/CLIPBOARD.md](/packages/manganese-clipboard/docs/CLIPBOARD.md) | Clipboard history and the browser-window clipboard on tty vs nested. |
| [/packages/manganese-wallpaper/docs/WALLPAPER.md](/packages/manganese-wallpaper/docs/WALLPAPER.md) | Wallpaper rotation, per-theme photos, crossfade, sources. |
| [/packages/shell-manganese/docs/SOURCE.md](/packages/shell-manganese/docs/SOURCE.md) | How the root composes manganese's packages, and its source map. |

## Checking your work

```sh
bun run check                                  # everything
bun run turbo run test:rust                    # or one task: test, test:rust, test:e2e, test:nix, test:distro
```

That is the whole answer, and using it is not optional politeness — it is how
you find the things the unit tests cannot. It runs `fmt`, `clippy`, `cargo
test`, `biome`, `turbo test` (each package's unit tests, types and
`tests/*.sh`), `turbo test:e2e`, `turbo test:nix` and `turbo test:distro`, and
it installs `node_modules` when a fresh worktree has none.

**Read a `skipped` line as loudly as a failure.** A skip means a check did not
run, which on a machine without a GPU is a fact rather than a verdict — but it is never evidence that the thing works. A script that cannot
run says so by exiting **77**, which is the only thing that distinguishes it
from one that ran and passed; before that existed, a green CI run reported ten
suites where nine had run. A turbo task that passes prints the skips inside it
under its `ok`.

CI adds `DOMICILE_CHECK_STRICT=1`, where a skip *is* a failure, and names the
one it expects (`DOMICILE_CHECK_ALLOW_SKIP=e2e-dmabuf`, because no runner has a
DRM render node). That pair is the point: the expected skip stays green, and a
*new* one — a display that never came up, a tool that left the shell — is
fatal.

Three things this cannot reach, so do not read a green run as covering them:

- **The dmabuf import.** It needs a DRM render node; `e2e-dmabuf.sh` says so
  and stops. Everything around the import is reachable — see `dmabuf_import`'s
  own tests — and anything you put *inside* it is not covered by anything.
- **Presentation.** The pixel tests read an offscreen buffer back; no check
  puts a window on a screen.
- **Hardware timing.** `commit_ms`, `response_ms` and the rest come off a
  software rasterizer here, which flatters some stages and punishes others.
  Numbers from this container are directional, not results.

## Per-package addenda

When working on any package in `/packages/`, you MUST check for
and load package-specific agent instructions in `{package}/docs/AGENTS.md`,
if such a file exists. These hold rules specific to the package and augment —
never weaken — the root docs. On conflict, package rules win. They are
addenda-only: they do not relist root rules; assume you have already loaded
them.

DO NOT proceed with any changes until the relevant files are loaded and
understood.
