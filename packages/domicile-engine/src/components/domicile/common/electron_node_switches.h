// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_COMMON_ELECTRON_NODE_SWITCHES_H_
#define COMPONENTS_DOMICILE_COMMON_ELECTRON_NODE_SWITCHES_H_

namespace domicile {

// A renderer started for an Electron window that isn't sandboxed, whose page
// has Node.js. The browser starts it without the sandbox or the zygote, as
// Electron does, and gives it to that window alone; only such a renderer
// starts Node. See "Phase 2" in docs/architecture/ELECTRON-APPS.md and
// components/domicile/renderer/electron_node.h.
inline constexpr char kDomicileElectronNodeSwitch[] = "domicile-electron-node";

// The V8 flag Node needs in a renderer: it sets V8 flags as it starts, after
// the renderer's V8 is up, and V8 otherwise freezes them then.
inline constexpr char kElectronNodeJsFlag[] = "--no-freeze-flags-after-init";

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_COMMON_ELECTRON_NODE_SWITCHES_H_
