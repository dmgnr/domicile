# @domicile-desktop/benchmarks

Measures Domicile's memory and CPU against other Wayland desktops, each in an
identical NixOS VM.

```sh
nix build .#benchmarks.drivers.sway -o driver
nix run .#benchmarks.run -- sway ./driver results 3
bun packages/benchmarks/src/main.ts results
```

`benchmarks.yml` runs every desktop on GitHub's runners when started by hand,
or with `host: crux` one at a time on crux's GPU (see below), holding both of
crux's runners so no other CI shares the machine.

## Desktops

`console` (no desktop, the VM's own cost), `domicile` (manganese), `sway`,
`hyprland`, `gnome` and `plasma`, each as its NixOS module sets it up. First-run
screens (GNOME's tour, Plasma's welcome) are left out. GNOME and Plasma never
dim, blank or lock the idle screen, as the others don't. manganese's clock
shows minutes only and its wallpaper stays put (`shell_options`), so it
doesn't redraw every second or minute at rest.

## Workloads

- **rest**: the desktop alone.
- **chat-and-web**: Slack signed in, and a browser on three pages.
- **chat-web-and-editor**: the same, plus VSCodium on a project.

On Domicile, the pages are browser windows of its engine, and Slack and
VSCodium run on the engine through `electron-host`. Elsewhere, Chromium,
Slack's Electron and VSCodium's Electron run on their own.

## A run

- A fresh boot per run: 4 cores, 8 GiB, a 2D `virtio-gpu` card at 1920x1080,
  so every desktop renders on the CPU.
- The desktop settles for 2 minutes, the apps start, then settle 2 more.
- Every 10 seconds for 5 minutes the VM records memory in use
  (`MemTotal - MemAvailable`), the PSS of every process and of the user's,
  CPU ticks and the load average. Over the same window it records each
  thread's CPU, so a run's `threads` names the 25 busiest (program,
  Chromium's process type, thread) as a percentage of one core.
- The apps load live pages, so the network adds variance.

`src/main.ts` reports the median run of each and its range.

## On a GPU

`benchmarks.gpuDrivers` give the VM a 3D card (`virtio-vga-gl`) that virgl
draws on the host's GPU, so the desktops and apps render as they would on real
hardware, give or take virgl's translation of their GL calls. `bin/run.sh`
takes the host card's render node in `BENCH_RENDER_NODE`. Beside each sample
the host also reads QEMU's CPU ticks and, from `nvidia-smi pmon`, its share of
an NVIDIA card's time and memory, and each run logs the guest's GL renderer
and the engines' GPU flags as proof of what drew.

## Slack

`bin/slack-magic-link.py` takes the test workspace's subdomain in
`BENCH_SLACK_WORKSPACE` and a signed-in browser's `d` cookie in
`BENCH_SLACK_COOKIE`, then fetches the one-time `slack://` link that signs the
desktop app in. A password sign-in from a fresh machine asks for an emailed
code, so the cookie stands in for it. The cookie expires: when the run says
it "isn't a signed-in session", sign in to the workspace in a browser and
set the secret to its new `d` cookie. On failure it prints the page's text
and saves a screenshot to `BENCH_SLACK_DEBUG`, never its HTML, which holds the
session's tokens.
