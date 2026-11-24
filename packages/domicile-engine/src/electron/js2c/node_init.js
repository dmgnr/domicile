// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

// The embedder bundle Node runs where Electron runs its own `node_init`: in a
// page that asks for Node. Nothing loads it until Node is in pages; see
// "Phase 2" in docs/architecture/ELECTRON-APPS.md.
"use strict";
