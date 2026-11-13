# @domicile-desktop/site

## 0.2.1

### Patch Changes

- 9f22031: Document running X11 apps through xwayland-satellite.
- Updated dependencies [d0fbc5b]
- Updated dependencies [d566f68]
- Updated dependencies [87ac040]
- Updated dependencies [24b88fb]
- Updated dependencies [81215c5]
- Updated dependencies [3e37020]
- Updated dependencies [3bdac3b]
- Updated dependencies [2a1913f]
- Updated dependencies [da632d6]
- Updated dependencies [a5ade39]
- Updated dependencies [8c477cc]
- Updated dependencies [996cc29]
- Updated dependencies [9bd54ab]
- Updated dependencies [8ff882e]
- Updated dependencies [25522ef]
- Updated dependencies [e821d1f]
- Updated dependencies [19cc2c5]
  - @domicile-desktop/sdk@2.3.0
  - @domicile-desktop/component-library@2.1.1
  - @domicile-desktop/react@0.1.3

## 0.2.0

### Minor Changes

- fe97fd8: Reframe the site around blurring the web and the desktop: a new homepage story (why unify, what becomes possible, build something weird, manganese), a "How it works" docs page, new demo captures, and a "Built with AI" answer in the FAQ.

### Patch Changes

- 7e3f354: Shells can use WebAssembly, so a shell can be written in Rust or another language that compiles to wasm. `examples/dioxus-shell` is one, in Dioxus.
- b8a88e2: The FAQ and "How a shell works" say a shell can be written in Rust, and point to the Dioxus example.
- 1bc9dd8: The homepage's "You're already running a browser." diagrams show Electron apps, each with its own Chromium, beside Domicile apps that share the one engine. On phones the diagrams drop their cards and the small boxes show only their titles.
- b8a88e2: Polish the "You're already running a browser" diagrams, reword the speed FAQ, and drop "Anthropic's AI model" from the AI disclosure.
- 56bab6c: Add Vercel Web Analytics to the site.
- c169f08: Fix joining #domicile:domicile-desktop.com: delegate Matrix federation to www, since the bare domain redirects there.
- 50318b4: The notifications panel's Do not disturb switch is now a Pause button in its header. Pause for 1 hour, until 8 AM tomorrow, or until you resume; the header says until when, and Resume ends it early. Clear all moves beside the Recent label. Do not disturb left on carries over as a pause until resumed.
  
  - `useNotifications` returns `pause`, `pauseFor` and `resume` in place of `doNotDisturb` and `setDoNotDisturb`.
  - `NotificationDrawer` takes `pause`, `onPause` and `onResume` in place of `doNotDisturb` and `onDoNotDisturb`; `NotificationBell` and the drawer context take `paused`.
  - The component library adds `Menu`, a menu opened from a button, and a `status` line on `PanelHeader`.
- e8696d9: `domicile load-shell` goes back to the shell you had when the new one fails to run, and prints why.
- Updated dependencies [f9bbf5d]
- Updated dependencies [c664ef4]
- Updated dependencies [1af639c]
- Updated dependencies [eba7d0d]
- Updated dependencies [62ccd23]
- Updated dependencies [af7415e]
- Updated dependencies [bb1e4cb]
- Updated dependencies [c1988f7]
- Updated dependencies [d69b2f4]
- Updated dependencies [e81703a]
- Updated dependencies [8eaae53]
- Updated dependencies [f592184]
- Updated dependencies [18413ff]
- Updated dependencies [69fe0d8]
- Updated dependencies [3d22f74]
- Updated dependencies [a354497]
- Updated dependencies [75708d7]
- Updated dependencies [9246b97]
- Updated dependencies [50318b4]
- Updated dependencies [cdb3534]
- Updated dependencies [eeb9468]
  - @domicile-desktop/component-library@2.1.0
  - @domicile-desktop/sdk@2.2.0
  - @domicile-desktop/react@0.1.2

## 0.1.1

### Patch Changes

- 67c29a9: The site deploys from `release` and links files on `release`.
- Updated dependencies [fdad979]
  - @domicile-desktop/sdk@2.1.0
  - @domicile-desktop/component-library@2.0.1
  - @domicile-desktop/react@0.1.1

## 0.1.0

### Minor Changes

- f270614: The landing page leads with "Make your own desktop": pick a window model, edit its React and Tailwind live, then download it and run it for real. Also a showcase of asks and the code that does them, a "Made for fast iteration" section, and /llms.txt for coding agents.

### Patch Changes

- a1c6226: A "Build an app" guide: web apps, and app modules in React, on the site at /docs/apps/build.
- 17b142c: The Cast popover matches the Bluetooth panel: a titled panel with Casting and TVs nearby sections. Each TV has Extend and Show… buttons, a running cast has Stop, and a failed cast says why under its TV. The bar icon no longer turns teal while casting.
- 06cf6dd: The homepage FAQ names the Chromium version and revision the engine is built on, read from the engine's pin, and says how a newer Chromium reaches you. `CHROMIUM_VERSION` holds the pin's version, and a check keeps the two in step.
- 1161efd: `domicile --help` (or `-h`, `help`, or `<verb> --help`) lists every command.
- a16de29: A reference page for every `domicile` command, on the site at /docs/reference/cli.
- 64ffcb7: `domicile theme [light|dark|toggle]` switches the desktop's theme from a terminal, or prints it. It works with any shell and needs no pointer.
- 3c11f00: The compatibility note says Intel GPUs are checked too.
- 400b6b7: Copy buttons on docs code blocks and the quickstart steps.
- 2670783: The install steps on both landing pages carry a one-line support note, linking to a new "What it runs on" page: architectures, distributions, Wayland-only apps, and which GPUs are checked.
- 348b5e3: Contributor docs move to docs/contributing; the site's Contributing link follows.
- 31f22af: The homepage FAQ tells a reload, an engine restart and a compositor restart apart, and says which windows each keeps.
- 22844b3: Docs audit: Wayland-only app support and the apps we check, the config schema served from domicile-desktop.com, locking in a `nix run` trial, portal requests a shell must answer, a complete packaging example, GPU troubleshooting for users, a NixOS flake example, differences from Chrome, and contributor-only sections labeled in the package references.
- e01fbd8: Docs media scenes for the tour's extensions and monitors, and the Settings app's Shell page.
- c80cd2a: Docs site: a folded docs menu on phones, "On this page" contents on long guides, a quick start for portal dialogs, accurate lock docs, and a line under the homepage's buttons for trying Domicile in a window.
- 32449d3: A docs link written as its page's file name, like `SHELL-FROM-MANGANESE.md`, reads as that page's title, like "Start from manganese". The quickstart's "Next" list links its own words.
- e8cb518: Docs media: a scene whose process ignores TERM no longer hangs the capture job.
- e44bc45: Docs screenshots can show full screen, like the videos, and captures draw the desktop in Inter rather than JetBrains Mono.
- d2531dd: Docs screenshots and videos load from media.domicile-desktop.com instead of shipping in every deployment.
- 24ef5af: Manganese page: smooth 60 fps videos, a tour with one big capture per row, an uncropped and longer hero, and tour captures for web apps, notifications, the bar and Settings.
- 56dd6c1: The manganese tour describes its new captures.
- bcbbd7d: Tabbed examples on docs pages no longer overlap what follows them and sit clear of their tab bar, and a docs page's pictures no longer nest a block in a paragraph.
- 8a380bd: Docs: picking a tab no longer jumps the page, and `js` code blocks are highlighted.
- 1c497d4: The docs site renders the new user guide (`docs/use`): tabs for the Settings app and the config file, screenshots from `docs/media`, and redirects from moved pages.
- e7a3770: The Domicile docs have their own Install page; manganese's keeps the same steps.
- e455955: `domicile open <file|folder|url>` opens anything: a web link in a browser window, anything else with its type's default from `mimeapps.list`, supertypes counted (a `text/plain` default opens Markdown and source code). `domicile open --app <url|module>` opens a site or app module as an app. Domicile's `xdg-open` and the launcher's Enter run it, so apps, terminals and the launcher agree. `open-url`, `open-app` and `run-app` are gone: use `open` and `open --app`.
- ab2d2f0: The engine hands `Shell` the typed `Domicile` and an app's `main` the `AppDomicile`, built by the SDK's layer, which the engine bundles. Shells and apps no longer call `desktop()`/`appDesktop()`. The SDK drops `system()`, the portal watch helpers and `./appearance` from its public API; use the `Domicile` namespaces.
- a93f4c5: Every "Make your own desktop" model starts apps: a command box at the bottom, and a terminal on Meta+Enter. The preview opens a window for each command.
- 75b9403: Ghost and other buttons in Settings, History and the site lose the outline they drew when not focused. The preset now sets the page's color scheme, light or dark, so packages no longer replace its `html` rules. A switch in Settings says "Off" when it is off.
- 5e57e17: The homepage gets ready for launch. Manganese moves up as three steps (use it, change a piece, make your own). The CSS examples join "Things you can do". Batteries is grouped by who provides what, with the full list behind a disclosure. The quickstart installs from the install guide, repository setup included, and ends with making the shell your login session's, and so does the builder's "Run it for real". Builder hints name the Code tab. Desktop apps is a short band, and there's a FAQ. Overclaims are fixed: the Steam tray, "at full speed" and "any video call". The homepage and the manganese page get their own titles, descriptions, canonical URLs and link preview images.
- 9446014: The homepage shows the shell being swapped live: a race and a film keep playing while `domicile load-shell` stacks them. The new `live-swap` recording is captured on crux like the other docs media.
- 1b3e994: The homepage leads with why: a new headline and a shorter intro, the real desktop capture right under them, fewer repeated sections and no eyebrow labels. The "Make your own desktop" preview draws its windows as apps, and "Things you can do" shows only Domicile features.
- b427f82: Known gaps moved to docs/KNOWN-GAPS.md; the site links there.
- 48a9f9c: The roadmap is now a list of known gaps, KNOWN-GAPS.md; the site's link reads "Known gaps".
- 2c0f9e7: Landing page: the feature cards under the hero lift and light up on hover and keyboard focus.
- aac880d: The landing page's section cards drop "Start from manganese".
- 02f2623: The homepage's live swap recording shows asciiquarium in a terminal beside the race, in place of a film that stretched to fit its half.
- 5e0723d: Manganese page: why to pick it first (tiling, websites as windows, extensions), a bar item of your own with its capture, "Coming from Sway?", and a way to try it in a window before the keys. Install tabs now come from the install guide.
- 2bf4b18: A desktop whose machine lacks the lock's PAM service, such as a `nix run` trial, does not lock: locked, nothing could unlock it. An urgent notification, "This screen won't lock", says so at startup, and the log names the file to add. Adding it turns the lock on with no restart. The Manganese page notes this under its trial command.
- d99cf25: Docs videos can play full screen, and the recordings show each key pressed in a caption, with tighter timing. The manganese hero opens its terminal and browser from the launcher.
- e0c0884: The homepage drops the "Rotate kitty 17 degrees" card.
- 1c7e183: The desktop stays smooth while the machine is busy without joining the `domicile` group: the engine asks rtkit to raise its drawing threads when the limits refuse. The NixOS module enables rtkit, and the packages recommend it. The group is optional and gives the most reliable result.
- b1041f8: The last package-specific scripts leave `scripts/`: `dev-shell` becomes a package the shells' `start:dev` runs, docs media capture moves into the site, `update-engine-release.sh` and the IDL check into the engine, and `smoke-compositor.sh` into the e2e harness.
- e645e06: Shell author docs on the site, React first: a one-file quickstart, starting from manganese, the guides and the package references, each product with its own sidebar.
- 66bfb0d: Shell and app examples, on the site and in the docs, come in React and in plain JavaScript, with a plain JavaScript example shell beside the React one.
- 5f8475c: Domicile page: a "Batteries included" section, a section on desktop apps, and cards in the hero that jump to the main sections.
- 1b6c11c: Docs pages: the manganese user guide, rendered from the repository's markdown under `/docs/`.
- e634596: A capture shown full screen is letterboxed on a screen of another shape instead of cropped.
- cc050c2: Give the real apt, dnf and zypper setup on the install tabs.
- b4d7504: Add a command line section led by `domicile load-shell`, show a short example under each SDK feature, and trim the Chromium talk.
- e1a71fa: The Matrix room is #domicile:domicile-desktop.com. The site answers Matrix's alias lookup for it; the room stays on prussin.net.
- feb5cfe: The Matrix room, #domicile:prussin.net, in every page's header and footer, with GitHub, as icon links.
- cdba491: Show real desktop apps in the site's captures (SuperTuxKart, Big Buck Bunny in mpv, Blender, GIMP, LibreOffice) instead of terminals, and retitle the hero "Your desktop, built like a web page."
- c31745e: Fix the Vercel build: install the repository root's tools so turbo can build the site's workspace packages.
- 7e64dce: The Domicile and manganese landing pages keep their header at the top of the window as you scroll, on screens from tablet width up.
- f6ffcb7: Stop Vercel deploying branches with a slash in their name.
- Updated dependencies [bafd922]
- Updated dependencies [fe90bca]
- Updated dependencies [77fd631]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [cb4d2f9]
- Updated dependencies [44eb13c]
- Updated dependencies [3980a9a]
- Updated dependencies [c7a232d]
- Updated dependencies [66d220b]
- Updated dependencies [a2def76]
- Updated dependencies [d3a65c5]
- Updated dependencies [eca2588]
- Updated dependencies [f15f43a]
- Updated dependencies [7c8d9e2]
- Updated dependencies [fc3ee2f]
- Updated dependencies [9d0934e]
- Updated dependencies [a9a62e8]
- Updated dependencies [fa78a81]
- Updated dependencies [509f948]
- Updated dependencies [a2ee8ea]
- Updated dependencies [22844b3]
- Updated dependencies [c80cd2a]
- Updated dependencies [c03a44b]
- Updated dependencies [9fe15f8]
- Updated dependencies [f71cc09]
- Updated dependencies [aeb6f92]
- Updated dependencies [40f5af3]
- Updated dependencies [ab2d2f0]
- Updated dependencies [17064a7]
- Updated dependencies [a88ce23]
- Updated dependencies [ecd3fba]
- Updated dependencies [0e8c788]
- Updated dependencies [62a671f]
- Updated dependencies [a1569c6]
- Updated dependencies [6fecbbd]
- Updated dependencies [258d9aa]
- Updated dependencies [d9f5353]
- Updated dependencies [fb9e591]
- Updated dependencies [14e6071]
- Updated dependencies [56e1c22]
- Updated dependencies [98d378e]
- Updated dependencies [54472b5]
- Updated dependencies [e42226f]
- Updated dependencies [506b12f]
- Updated dependencies [00e5da2]
- Updated dependencies [75b9403]
- Updated dependencies [3f7e261]
- Updated dependencies [b49fa3a]
- Updated dependencies [35b8470]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [2d2289b]
- Updated dependencies [7a29c8f]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [a999398]
- Updated dependencies [9d4a876]
- Updated dependencies [44d0983]
- Updated dependencies [7ac9e00]
- Updated dependencies [6825067]
- Updated dependencies [cd02e0e]
- Updated dependencies [840418d]
- Updated dependencies [7aa450b]
- Updated dependencies [57b5b1f]
- Updated dependencies [b2c6fd5]
- Updated dependencies [a472a59]
- Updated dependencies [93f015d]
- Updated dependencies [b85d9bb]
- Updated dependencies [01b9340]
- Updated dependencies [fccc784]
- Updated dependencies [2bf4b18]
- Updated dependencies [e1205bb]
- Updated dependencies [40d7378]
- Updated dependencies [670713c]
- Updated dependencies [e7cbd52]
- Updated dependencies [8bc5b85]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [bbf849b]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [4759ab2]
- Updated dependencies [3bb9bd5]
- Updated dependencies [0f4582e]
- Updated dependencies [d80e2f5]
- Updated dependencies [58d2cfe]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [a5bff8c]
- Updated dependencies [52a1d65]
- Updated dependencies [3e5b976]
- Updated dependencies [d138939]
- Updated dependencies [4064278]
- Updated dependencies [f4a973d]
- Updated dependencies [341debf]
- Updated dependencies [ae7874c]
- Updated dependencies [599d60f]
- Updated dependencies [74a9564]
- Updated dependencies [75799a0]
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [c4fe915]
- Updated dependencies [b1041f8]
- Updated dependencies [20a1fc5]
- Updated dependencies [065ff4b]
- Updated dependencies [1e2aeca]
- Updated dependencies [b39d80e]
- Updated dependencies [21b82af]
- Updated dependencies [427c184]
- Updated dependencies [ee63a45]
- Updated dependencies [66bfb0d]
- Updated dependencies [5a6a4fc]
- Updated dependencies [25b9bd3]
- Updated dependencies [113dabe]
- Updated dependencies [0bd0d2a]
- Updated dependencies [d9f5353]
- Updated dependencies [1971d87]
- Updated dependencies [b741b92]
- Updated dependencies [570e7bb]
- Updated dependencies [2edc3c1]
- Updated dependencies [b241f68]
- Updated dependencies [5d2376e]
- Updated dependencies [6c3db42]
- Updated dependencies [9c89f16]
- Updated dependencies [ca86667]
- Updated dependencies [0c58b28]
- Updated dependencies [ee1cc17]
- Updated dependencies [eb6b52a]
- Updated dependencies [63728a9]
  - @domicile-desktop/component-library@2.0.0
  - @domicile-desktop/sdk@2.0.0
  - @domicile-desktop/react@0.1.0
