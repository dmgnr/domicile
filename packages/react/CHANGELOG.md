# @domicile-desktop/react

## 0.1.3

### Patch Changes

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

## 0.1.2

### Patch Changes

- Updated dependencies [c664ef4]
- Updated dependencies [1af639c]
- Updated dependencies [eba7d0d]
- Updated dependencies [af7415e]
- Updated dependencies [bb1e4cb]
- Updated dependencies [d69b2f4]
- Updated dependencies [8eaae53]
- Updated dependencies [f592184]
- Updated dependencies [18413ff]
- Updated dependencies [69fe0d8]
- Updated dependencies [a354497]
- Updated dependencies [9246b97]
- Updated dependencies [cdb3534]
  - @domicile-desktop/sdk@2.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [fdad979]
  - @domicile-desktop/sdk@2.1.0

## 0.1.0

### Minor Changes

- c03a44b: New `@domicile-desktop/react`: `mount(App)` makes a shell's `Shell` or an app's `main`; `<DomicileProvider>`, `useDomicile`, `useAppDomicile`, `useWatch`, hooks for windows, displays, appearance, session and portals, and `<FakeDomicile>` for tests. The simple shell and the History and Settings apps mount with it.
- 01b9340: `<NestedShell shell>` (`@domicile-desktop/react/nested-shell`) runs another shell inside this one, on the same desktop.
- 1971d87: React hooks for system state. Each `system-*` package has a `/react` with hooks and one watch per desktop: `useBattery`, `useBluetooth`, `useNetwork`, `useWifi`, `useAudio` and more. `@domicile-desktop/react` gains the shared watches (`sharedWatch`, `perDesktop`, `useSharedWatch`, `useDeskWatch`, `watchPresence`). manganese-host's `domicile-context`, `per-host`, `shared-watch`, `useSharedWatch` and `watch-presence` move there, and manganese uses `<DomicileProvider>`.

### Patch Changes

- 22844b3: Docs audit: Wayland-only app support and the apps we check, the config schema served from domicile-desktop.com, locking in a `nix run` trial, portal requests a shell must answer, a complete packaging example, GPU troubleshooting for users, a NixOS flake example, differences from Chrome, and contributor-only sections labeled in the package references.
- ae7874c: `@domicile-desktop/react/elements` types the engine's `<app>` and `<webview>` in JSX, so a React shell writes `<app app-id={…} />` without declaring it.
- Updated dependencies [fe90bca]
- Updated dependencies [3980a9a]
- Updated dependencies [66d220b]
- Updated dependencies [d3a65c5]
- Updated dependencies [eca2588]
- Updated dependencies [22844b3]
- Updated dependencies [9fe15f8]
- Updated dependencies [40f5af3]
- Updated dependencies [ab2d2f0]
- Updated dependencies [17064a7]
- Updated dependencies [a88ce23]
- Updated dependencies [ecd3fba]
- Updated dependencies [0e8c788]
- Updated dependencies [62a671f]
- Updated dependencies [56e1c22]
- Updated dependencies [98d378e]
- Updated dependencies [e42226f]
- Updated dependencies [35b8470]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [a999398]
- Updated dependencies [9d4a876]
- Updated dependencies [44d0983]
- Updated dependencies [57b5b1f]
- Updated dependencies [b2c6fd5]
- Updated dependencies [93f015d]
- Updated dependencies [b85d9bb]
- Updated dependencies [fccc784]
- Updated dependencies [2bf4b18]
- Updated dependencies [3146073]
- Updated dependencies [bbf849b]
- Updated dependencies [3bb9bd5]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [52a1d65]
- Updated dependencies [3e5b976]
- Updated dependencies [75799a0]
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [b1041f8]
- Updated dependencies [20a1fc5]
- Updated dependencies [ee63a45]
- Updated dependencies [66bfb0d]
- Updated dependencies [d9f5353]
- Updated dependencies [6c3db42]
- Updated dependencies [9c89f16]
- Updated dependencies [ca86667]
- Updated dependencies [0c58b28]
- Updated dependencies [ee1cc17]
- Updated dependencies [eb6b52a]
  - @domicile-desktop/sdk@2.0.0
