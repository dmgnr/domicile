# @domicile-desktop/system-network

The network for a Domicile shell, from NetworkManager, iwd or wpa_supplicant:
connectivity and the primary connection, with the Wi-Fi network's name and
signal. The Wi-Fi device, from NetworkManager or iwd: its networks and
connection, and the requests that change them. Built on
the `dbus`, `files` and `processes` namespaces of
the [`Domicile`](../chrome-sdk/README.md) a shell is handed.

## Usage

```ts
import { watchNetwork } from "@domicile-desktop/system-network/network";

const stop = watchNetwork(domicile, (network) => {
  network.match({
    Err: () => hide(),
    Ok: ({ connectivity, link }) => show(connectivity, link),
  });
});
```

- `watchNetwork` watches the first service on the system bus, by
  `NameHasOwner`: NetworkManager, then iwd, then wpa_supplicant. With none, it
  watches NetworkManager. It does not switch if another starts later.
- To force one, call its watch, which takes the same arguments:

| Export | Service | Reads |
|---|---|---|
| `networkmanager` `watchNetworkManager` | `org.freedesktop.NetworkManager` | connectivity; `link` is `None`, `Wired`, `Wifi` or `Other` (VPNs and the rest) |
| `iwd` `watchIwd` | `net.connman.iwd` | the connected station's network; signal from `GetOrderedNetworks` |
| `wpa-supplicant` `watchWpaSupplicant` | `fi.w1.wpa_supplicant1` (only with `-u`) | the current BSS of an interface that is `completed` or rekeying (`group_handshake`) |

- iwd and wpa_supplicant know only Wi-Fi: `connectivity` is always `Unknown`,
  and `link` is `Wifi` or `None`, even with a cable plugged in.
- `strength` is 0 through 1. Both grade dBm as NetworkManager does: -100 dBm
  is 0, -40 dBm is 1. iwd's signal changes after each scan.
- Reports once, then after each change the service signals.
- An `Err` is a D-Bus failure, such as the service not running.
- A bug or an unexpected reply shape throws, logged to the console.

## Wi-Fi

```ts
import { connectWifi, watchWifi } from "@domicile-desktop/system-network/wifi";

const stop = watchWifi(domicile, (wifi) => {
  wifi.match({
    Err: () => hide(),
    Ok: (found) => found.match({ None: () => hide(), Some: (device) => show(device) }),
  });
});
await connectWifi(domicile, device, network, "passphrase");
```

- `watchWifi` watches the first Wi-Fi device of NetworkManager, else iwd, by
  `NameHasOwner`. `None` is no device, or neither service. wpa_supplicant is
  not controlled.
- Requests: `setWifiEnabled`, `scanWifi`, `connectWifi`, `disconnectWifi`,
  and for a saved network, `setWifiAutoJoin` and `forgetWifi`.
  Each resolves `Ok` once the service accepts it; the watch reports the
  outcome.
- `connectWifi` uses a network's saved profile when it has one. A new secured
  network needs a passphrase:
  - NetworkManager: a new WPA-PSK profile, saved.
  - iwd: `iwctl --passphrase … station <interface> connect <ssid>`, since iwd
    asks an agent for it and a page cannot serve one. `iwctl` must be on the
    compositor's `PATH`.
- `saved` is every saved network, in range or not: NetworkManager's Wi-Fi
  profiles (hotspots left out) or iwd's known networks. Each has its
  security, whether it joins by itself, and when it was last joined.
- `setWifiAutoJoin` on NetworkManager reads the profile and writes it back
  with `connection.autoconnect` changed. NetworkManager keeps its secrets.
- NetworkManager reads re-run on each property change of an object read, an
  access point coming or going, a device coming or going, or a profile
  added, removed or updated. It does not say
  when a scan runs, so `scanning` is always `false`.
- iwd does not report addresses, so `connection.ip` is `undefined`.

## Interfaces

```ts
import { watchAddresses, watchInterfaces } from "@domicile-desktop/system-network/interfaces";

const stop = watchInterfaces(domicile, (interfaces) => interfaces.map(show));
```

- `readInterfaces` lists `/sys/class/net`'s interfaces with a `device`:
  wired or wireless, hardware address, whether the link is up, and a wired
  link's speed. Loopback, bridges and VPNs are left out. Works while locked.
- `readAddresses` runs `ip -j address show` and `ip -j route show default`:
  each interface's lasting global IPv4 and IPv6 addresses (temporary IPv6
  addresses left out) and default gateway. `ip` must be on the compositor's
  `PATH`.
- The watches read every 5 seconds, since a cable's carrier sends no uevent,
  and report only a change.

## Captive portals

```ts
import { checkPortal } from "@domicile-desktop/system-network/portal";

(await checkPortal(domicile)).map((portal) =>
  portal.map((url) => domicile.browser.open(url)),
);
```

- `checkPortal` asks `curl` for `http://www.gstatic.com/generate_204`
  without following redirects, as Chrome does. `204` is `None`. Any other
  answer is `Some` of the sign-in page: the redirect's target, else the probe.
- It retries a probe with no answer three times, since an address can arrive
  after the link. An `Err` is a probe that never got an answer.
- `curl` must be on the compositor's `PATH`.

See [SHELL-SYSTEM-ACCESS.md](/docs/SHELL-SYSTEM-ACCESS.md).

## React

`@domicile-desktop/system-network/react`, for a shell on
[`@domicile-desktop/react`](../react/README.md):

- `useNetwork()`, `useNetworkInterfaces()`, `useAddresses()`, `useWifi()`:
  each `undefined` until first read.
- `deskNetwork(domicile)`: the shared watches behind them, one per desktop.
  The network service refuses calls while the desktop is locked, so those
  watches start again on unlock (`watchAcrossLocks`).

## Test

```sh
bun run turbo test --filter @domicile-desktop/system-network
```

Tests replay D-Bus replies, in the compositor's JSON, through an injected
`dbus` namespace.
