// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/history_menu.h"

#include <utility>

#include "base/check_op.h"

namespace domicile {

mojom::WebViewHistoryPtr HistoryMenu(
    std::vector<mojom::WebViewHistoryEntryPtr> entries,
    int current) {
  CHECK_GE(current, 0);
  CHECK_LT(static_cast<size_t>(current), entries.size());

  auto menu = mojom::WebViewHistory::New();
  for (int i = current - 1; i >= 0; --i) {
    menu->back.push_back(std::move(entries[i]));
  }
  for (size_t i = current + 1; i < entries.size(); ++i) {
    menu->forward.push_back(std::move(entries[i]));
  }
  return menu;
}

}  // namespace domicile
