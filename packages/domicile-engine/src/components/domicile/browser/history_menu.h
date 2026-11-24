// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_HISTORY_MENU_H_
#define COMPONENTS_DOMICILE_BROWSER_HISTORY_MENU_H_

#include <vector>

#include "components/domicile/mojom/web_view_guest.mojom.h"

namespace domicile {

// Splits a guest's history, oldest first, around its current entry at index
// `current` into the pages behind and ahead of it, each nearest first. See
// WebViewGuest.ListHistory in components/domicile/mojom/web_view_guest.mojom.
mojom::WebViewHistoryPtr HistoryMenu(
    std::vector<mojom::WebViewHistoryEntryPtr> entries,
    int current);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_HISTORY_MENU_H_
