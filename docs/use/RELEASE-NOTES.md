# Release notes

What's new in manganese, the desktop, in each release. What's new for people
building shells is in [Domicile's release notes](../RELEASE-NOTES.md).

## 1.3.0

_Unreleased_

### Electron apps on the desktop's browser

![Element on the desktop's browser, with its menu bar under its tab](../media/release-electron.png)

Slack, Element, Claude and other Electron apps run on the desktop's browser, with menus and dialogs in the desktop's style.

[How to turn it on](ELECTRON-APPS.md) · [#2091](https://github.com/cprussin/domicile/pull/2091) · [#2162](https://github.com/cprussin/domicile/pull/2162) · [#2173](https://github.com/cprussin/domicile/pull/2173) · [#2243](https://github.com/cprussin/domicile/pull/2243) · [#2256](https://github.com/cprussin/domicile/pull/2256) · [#2283](https://github.com/cprussin/domicile/pull/2283) · [#2302](https://github.com/cprussin/domicile/pull/2302) · [#2316](https://github.com/cprussin/domicile/pull/2316)

### Let agents use your desktop

Claude Code, claude.ai, ChatGPT and other agents can use your desktop, all of it or only the windows you pick. One pill in the bar lists every agent at work, and you can stop any of them at any time. An agent can also leave on its own when it's done.

[How to set it up](AGENTS.md)

### Browser profiles

![The profile menu, open from the address bar](../media/release-profiles.png)
![Settings' Profiles page](../media/release-profiles-settings.png)

Keep work and personal apart: each profile has its own sign-ins and extensions, and opens the sites you give it.

[Profiles](BROWSER.md#profiles) · [#2212](https://github.com/cprussin/domicile/pull/2212) · [#2231](https://github.com/cprussin/domicile/pull/2231) · [#2234](https://github.com/cprussin/domicile/pull/2234) · [#2236](https://github.com/cprussin/domicile/pull/2236) · [#2259](https://github.com/cprussin/domicile/pull/2259)

### Also new

- Email links, in apps and on web pages, ask which Gmail inbox or alias to write from, then open a new message in that inbox. Each Gmail account signs in once more, for its aliases. [Notifications](NOTIFICATIONS.md#inboxes)
- Remove a copy from the clipboard history with its Remove button or the Delete key. Removing what is on your clipboard empties it. [Clipboard](CLIPBOARD.md)
- Spell checking in every text field: right-click a misspelled word for suggestions, or add it to your dictionary. [Spelling](BROWSER.md#spelling)
- Drag text, a link or an image onto a group's tabs to open it in a new tab there. [The browser](BROWSER.md)
- Pop a video out of its page to float it over everything. [#2077](https://github.com/cprussin/domicile/pull/2077) · [#2116](https://github.com/cprussin/domicile/pull/2116) · [#2177](https://github.com/cprussin/domicile/pull/2177)
- HDR per monitor in Settings, and 10-bit color without banding. [Monitors](MONITORS.md) · [#1974](https://github.com/cprussin/domicile/issues/1974)
- Press and hold Back or Forward to jump to any page before or after. [The address bar](BROWSER.md#the-address-bar) · [#2251](https://github.com/cprussin/domicile/pull/2251)
- Ctrl+click Back, Forward, a page in their menus or a profile to open it in a new window, as a middle click does. [The address bar](BROWSER.md#the-address-bar)
- Put your browser profiles in any order and give them any color, in Settings. [Profiles](BROWSER.md#profiles) · [#2263](https://github.com/cprussin/domicile/pull/2263)
- See your saved Wi-Fi networks in quick settings, in range or not: turn joining automatically on or off, or forget one. [The top bar](TOP-BAR.md) · [#2334](https://github.com/cprussin/domicile/pull/2334)
- Panels with nothing to show, or that couldn't read something, say so with a picture and what to do next, instead of a line of text. Saved Wi-Fi networks open from a button beside the Wi-Fi switch.
- Quick settings lights Wi-Fi, Wired and Bluetooth while connected. [The top bar](TOP-BAR.md) · [#2266](https://github.com/cprussin/domicile/pull/2266)
- The tray's menu pins icons and switches extensions. [#2137](https://github.com/cprussin/domicile/pull/2137)
- Tap Super, or swipe up with four fingers, for the overview. [Overview](WINDOWS.md#overview) · [#2065](https://github.com/cprussin/domicile/pull/2065) · [#2148](https://github.com/cprussin/domicile/pull/2148)
- Keep one wallpaper instead of a new one every minute: Settings › Shell. [Wallpaper](APPEARANCE.md#wallpaper)
- The night light fades in and out. [Night light](MONITORS.md#night-light) · [#2181](https://github.com/cprussin/domicile/pull/2181)
- Meta+W merges side-by-side windows into tabs. [Layout](KEYS.md#layout) · [#2093](https://github.com/cprussin/domicile/pull/2093)
- Extensions can run in private windows. [Extensions](BROWSER.md#extensions) · [#2060](https://github.com/cprussin/domicile/pull/2060)
- "Sign in with Google" works. [#2086](https://github.com/cprussin/domicile/pull/2086)
- Games can lock the pointer. [#2057](https://github.com/cprussin/domicile/pull/2057) · [#2123](https://github.com/cprussin/domicile/pull/2123)
- Input methods such as fcitx5 and IBus. [#2059](https://github.com/cprussin/domicile/pull/2059) · [#2062](https://github.com/cprussin/domicile/pull/2062)
- Type `!g` in the launcher to search Google straight away, without other matches. [Launcher](LAUNCHER.md)
- Terminal apps in the launcher. [#2069](https://github.com/cprussin/domicile/pull/2069)
- Per-monitor mode, refresh rate and adaptive sync. [Monitors](MONITORS.md) · [#2031](https://github.com/cprussin/domicile/pull/2031) · [#2048](https://github.com/cprussin/domicile/pull/2048)
- Key repeat settings. [#2024](https://github.com/cprussin/domicile/pull/2024)
- Firefox animates with the desktop. [#2087](https://github.com/cprussin/domicile/pull/2087) · [#2089](https://github.com/cprussin/domicile/pull/2089)
- Windows no longer freeze at their old size after you move or resize them on monitors of different sharpness.
- Settings has a Troubleshooting page: turn on detailed logging, and save the logs to attach to a bug report.
- Detailed logging says what each window, workspace, overview and scratchpad action did, so saved logs show how the desk got where it is.
- Chromium 160. [#2023](https://github.com/cprussin/domicile/pull/2023)

### Fixes

- The night light warms the pointer on a DisplayLink monitor too, instead of leaving it looking blue.
- A download that waits on a picker nobody answers, such as a Slack download from a hidden window, no longer stops every later download in the browser from asking where to save. "Save video as…" asks again.
- Speakers behind sound correction show as muted when the hardware behind them is muted, and unmuting them unmutes it. The hardware itself is no longer offered as a separate choice.
- Switching workspaces keeps a floating window that hangs off the screen on its own workspace, instead of sliding its off-screen part into view.
- The screen stays black from the boot screen until the desktop draws, instead of flashing white. [#2467](https://github.com/cprussin/domicile/issues/2467)
- Menus, tooltips and dialogs show over a fullscreen window, such as Claude's menu button in fullscreen.
- Menus, panels and tooltips close when the overview, a fullscreen window or the scratchpad moves or covers what they belong to, instead of floating out of place.
- The pointer keeps your cursor theme and size after you undock.
- GTK3 apps and Firefox no longer burn CPU and stutter while they draw their windows. [#2466](https://github.com/cprussin/domicile/issues/2466)
- In a virtual machine (VMware, VirtualBox, QEMU), the pointer's tip is where your clicks land. [#2432](https://github.com/cprussin/domicile/issues/2432)
- Logging out, restarting or shutting down no longer counts as a browser crash, so the browser saves your profile on the way out.
- Slack's notifications show their Reply button instead of an empty row.
- Downloading a file in Slack saves it, instead of leaving a hidden temporary file. Other Electron apps' downloads go where the app says too.
- Switching workspaces and tabs is smoother on battery: a window you come back to draws what it kept instead of drawing its whole page again.
- Wi-Fi's Disconnect and a saved network's Forget are red, and a row's folded details sit tighter around their buttons.
- You can drag text, images and links within and between pages.
- A nested tab group's last window drags out past the group when the group is the first or last tab.
- The open tab's outline is unbroken around its close button.
- The lock screen's passphrase field always looks focused while you type into it.
- A launcher tag typed after the words, as in `kate bush !yt`, searches on Enter instead of filling in the tag again.
- The desktop takes about 35 MB less memory at rest: the browser keeps one process ready for a new page instead of two.
- The desktop takes about 35 MB less memory at rest: the browser starts its audio service only when something plays sound or asks for a microphone or camera.
- Ctrl+C and Escape work when you select an area on screen for a screenshot or a share. [Screenshots](SCREENSHOTS.md)
- Selecting an area on screen works while the launcher is open. [Screenshots](SCREENSHOTS.md)
- Print takes a screenshot while the launcher is open, with the launcher dimmed behind the picker, and pressing it again in the screenshot picker no longer opens a second picker once you close the first. [Screenshots](SCREENSHOTS.md)
- The wallpaper takes less memory on screens smaller than 4K: it downloads each photo only as large as your screens show it.
- Screenshot, share and other dialogs fade out when you answer them, instead of vanishing.
- Sharing your screen or a window in Google Meet asks once, not twice.
- A site's notifications show the site's icon instead of the browser's.
- "Open Slack" and other buttons that open an app from a page work again.
- A key bound to a program that isn't installed says so in a notification instead of doing nothing.
- Logging out closes the apps you started from the desk, and what they left running in the background, instead of leaving them running into your next login.
- Logging out ends Miracast casting, instead of leaving it running into your next session.
- Logging out of a desk started from a text console (tty) ends its programs, such as Miracast casting, instead of leaving them running into your next login.
- Agents can start programs, drag on pages, and press Enter by typing a new line.
- The tray's menu of every icon opens after you drag icons around. A right click anywhere on an app's row opens its menu, and long extension names are cut short instead of pushing their buttons out.
- Extensions stay on and keep their sign-ins and settings when the desktop restarts, instead of starting over or switching off. [#2481](https://github.com/cprussin/domicile/issues/2481)
- A Gmail notification opens its mail beside your inbox, once Gmail has synced it. [Inboxes](NOTIFICATIONS.md#inboxes) · [#2284](https://github.com/cprussin/domicile/pull/2284)
- Zooming a PDF zooms the document once, and the viewer's toolbar keeps its size. [#2437](https://github.com/cprussin/domicile/pull/2437)
- PDFs stay sharp and no longer go blank. [#2038](https://github.com/cprussin/domicile/pull/2038) · [#2080](https://github.com/cprussin/domicile/pull/2080) · [#2100](https://github.com/cprussin/domicile/pull/2100)
- Smoother windows on heavy pages, adaptive sync monitors and the overview. [#2227](https://github.com/cprussin/domicile/pull/2227) · [#2094](https://github.com/cprussin/domicile/pull/2094) · [#2041](https://github.com/cprussin/domicile/pull/2041)
- Less battery use while idle. [#2143](https://github.com/cprussin/domicile/pull/2143) · [#2138](https://github.com/cprussin/domicile/pull/2138)
- DisplayLink docks no longer freeze the desktop. [#2043](https://github.com/cprussin/domicile/pull/2043) · [#2045](https://github.com/cprussin/domicile/pull/2045)
- The lock screen always gets your typing. [Locking and sleep](LOCK-AND-IDLE.md) · [#2039](https://github.com/cprussin/domicile/pull/2039) · [#2140](https://github.com/cprussin/domicile/pull/2140)
- A notification says so when the desktop can't use your graphics card. [Graphics problems](TROUBLESHOOTING.md#graphics-problems) · [#2071](https://github.com/cprussin/domicile/pull/2071)

Special thanks to: [ploug](https://github.com/ploug), [mecattaf](https://github.com/mecattaf) & [yanbab](https://github.com/yanbab)

## 1.2.0

_November 10, 2026_

### The overview

![Every workspace at once](../media/release-overview.png)

Every workspace on a monitor at once. Meta+O, a four-finger pinch, or the button in the bar.

[#1931](https://github.com/cprussin/domicile/pull/1931) · [#1940](https://github.com/cprussin/domicile/pull/1940) · [#1946](https://github.com/cprussin/domicile/pull/1946)

### Gestures

Four-finger swipes change workspace, swipes in from a touchscreen's edge, and a pinch zooms like on a Mac.

[#1913](https://github.com/cprussin/domicile/pull/1913) · [#1925](https://github.com/cprussin/domicile/pull/1925) · [#1929](https://github.com/cprussin/domicile/pull/1929) · [#1996](https://github.com/cprussin/domicile/pull/1996)

### The desktop's own dialogs

Sign-in, permission and "Open Zoom?" prompts, pickers, tooltips and error pages, in the desktop's style.

[#1893](https://github.com/cprussin/domicile/pull/1893) · [#1895](https://github.com/cprussin/domicile/pull/1895) · [#1898](https://github.com/cprussin/domicile/pull/1898) · [#1901](https://github.com/cprussin/domicile/pull/1901)

### Also new

- Pause notifications for a while. [#2001](https://github.com/cprussin/domicile/pull/2001)
- Night light apps such as gammastep. [#1921](https://github.com/cprussin/domicile/pull/1921)
- Hide the pointer while typing. [#1945](https://github.com/cprussin/domicile/pull/1945)
- Touchpad and mouse settings. [#1884](https://github.com/cprussin/domicile/pull/1884)
- Touchscreens work in apps. [#1924](https://github.com/cprussin/domicile/pull/1924)

## 1.1.1

_November 4, 2026_

- Window and screen shares carry sound. [#1849](https://github.com/cprussin/domicile/pull/1849)
- Middle-click Back or Forward to open it in a new window. [#1848](https://github.com/cprussin/domicile/pull/1848)
- App windows show in VMs without 3D. [#1854](https://github.com/cprussin/domicile/pull/1854) · [#1856](https://github.com/cprussin/domicile/pull/1856)

## 1.0.0

_November 3, 2026_

![Manganese](../media/manganese-hero.png)

The first release: a tiling desktop that feels like Sway, where websites tile and tab alongside your apps.

- Sway's layouts and keys, with websites tiling beside your apps.
- Chrome extensions, the launcher, quick settings, notifications and inboxes.
- Clipboard history, screenshots, screen recording and casting to a TV.
- Night light and automatic brightness.
- Settings and History apps.
- Packages for Debian, Ubuntu, Fedora, openSUSE, Arch and NixOS.

[Install](INSTALL.md)
