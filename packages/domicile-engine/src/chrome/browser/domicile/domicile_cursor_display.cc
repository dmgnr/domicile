// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_cursor_display.h"

#include "base/check.h"
#include "base/logging.h"
#include "components/domicile/browser/cursor_display.h"
#include "ui/aura/client/cursor_client.h"
#include "ui/aura/window.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"

namespace domicile {

void FitCursorToDisplayOf(aura::Window* root) {
  aura::client::CursorClient* client = aura::client::GetCursorClient(root);
  CHECK(client) << "domicile: the desk's host has no cursor client";
  const display::Display now =
      display::Screen::Get()->GetDisplayNearestWindow(root);
  const display::Display& drawn_for = client->GetDisplay();
  if (!CursorDisplayStale(drawn_for, now)) {
    return;
  }
  VLOG(1) << "domicile: the pointer was drawn for display " << drawn_for.id()
          << " at scale " << drawn_for.device_scale_factor()
          << "; the desk's host is on " << now.id() << " at scale "
          << now.device_scale_factor();
  client->SetDisplay(now);
}

}  // namespace domicile
