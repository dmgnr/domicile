// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EVENT_NAMES_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EVENT_NAMES_H_

#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"

// The events the desktop dispatches, one line each: the name a page
// listens for, and the function that names it here.
//
// NOT IN core/events/event_type_names.json5, which is where Blink keeps its
// own and where these were. That file generates a header nearly all of Blink
// includes, so adding a name there recompiled most of Blink: engine run
// 36179223074 added one and built for 79 minutes at 4.5% compiler-cache hits.
// Only this directory includes this file.
//
// Nothing about the events changes by living here. A page hears the same
// type, dispatch compares AtomicStrings by pointer wherever they were made,
// and each is made once, on the main thread, the first time it is used.
// scripts/test-engine-event-names.sh keeps this list, the IDL's on<name>
// handlers and the list guard-windows-state fires in a real engine the same
// set.
#define DOMICILE_EVENT_NAMES(X)                                   \
  X(shortcut, Shortcut)                                           \
  X(shortcutrelease, Shortcutrelease)                             \
  X(gesture, Gesture)                                             \
  X(focusrequested, Focusrequested)                               \
  X(displayschanged, Displayschanged)                             \
  X(browserwindowschanged, Browserwindowschanged)                 \
  X(castsinkschanged, Castsinkschanged)                           \
  X(downloadschanged, Downloadschanged)                           \
  X(pictureinpicturevideoschanged, Pictureinpicturevideoschanged) \
  X(windowschanged, Windowschanged)                               \
  X(focusedwindowchanged, Focusedwindowchanged)                   \
  X(clipboardchanged, Clipboardchanged)                           \
  X(traychanged, Traychanged)                                     \
  X(notificationschanged, Notificationschanged)                   \
  X(extensionschanged, Extensionschanged)                         \
  X(extensionpopuprequested, Extensionpopuprequested)             \
  X(idlechanged, Idlechanged)                                     \
  X(lockedchanged, Lockedchanged)                                 \
  X(themechanged, Themechanged)                                   \
  X(windowsthemechanged, Windowsthemechanged)                     \
  X(modifierschanged, Modifierschanged)                           \
  X(appearancechanged, Appearancechanged)                         \
  X(shelloptionschanged, Shelloptionschanged)                     \
  X(system, System)                                               \
  X(portalrequests, Portalrequests)                               \
  X(compositorreplaced, Compositorreplaced)

namespace blink::domicile_event_names {

#define DOMICILE_DECLARE_EVENT_NAME(lower_name, function_name) \
  const AtomicString& function_name();
DOMICILE_EVENT_NAMES(DOMICILE_DECLARE_EVENT_NAME)
#undef DOMICILE_DECLARE_EVENT_NAME

}  // namespace blink::domicile_event_names

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EVENT_NAMES_H_
