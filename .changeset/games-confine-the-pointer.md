---
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/e2e-harness": patch
---

Games and VM viewers can confine the pointer to their window, or the part of it they name, and read raw mouse motion. On a console the engine holds its cursor inside the boxes the shell passes to the new `DomicileHost.confinePointer` (`pointer.confine` in the SDK), across monitors too; `DomicileWindow.pointerRegion` is the client's region. Relative motion now carries the mouse's unaccelerated deltas from libinput as `dx_unaccel`/`dy_unaccel`, so aiming no longer follows pointer acceleration, and a shell's warp still sends no motion. Manganese confines the pointer for the focused window that asks, and follows it as it moves.
