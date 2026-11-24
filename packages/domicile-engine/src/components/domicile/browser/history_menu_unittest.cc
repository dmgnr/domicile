// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/history_menu.h"

#include <utility>
#include <vector>

#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace domicile {
namespace {

std::vector<mojom::WebViewHistoryEntryPtr> Entries(int count) {
  std::vector<mojom::WebViewHistoryEntryPtr> entries;
  for (int i = 0; i < count; ++i) {
    entries.push_back(mojom::WebViewHistoryEntry::New(
        /*id=*/100 + i, GURL("https://example.com/"), "", ""));
  }
  return entries;
}

std::vector<int32_t> Ids(const std::vector<mojom::WebViewHistoryEntryPtr>& of) {
  std::vector<int32_t> ids;
  for (const mojom::WebViewHistoryEntryPtr& entry : of) {
    ids.push_back(entry->id);
  }
  return ids;
}

TEST(HistoryMenuTest, EachSideListsItsPagesNearestFirst) {
  const mojom::WebViewHistoryPtr menu =
      HistoryMenu(Entries(5), /*current=*/2);

  // Chrome's back menu starts one step back, as its forward menu starts one
  // step forward.
  EXPECT_EQ(Ids(menu->back), (std::vector<int32_t>{101, 100}));
  EXPECT_EQ(Ids(menu->forward), (std::vector<int32_t>{103, 104}));
}

TEST(HistoryMenuTest, TheEndsOfTheHistoryHaveNothingPastThem) {
  const mojom::WebViewHistoryPtr first = HistoryMenu(Entries(3), 0);
  EXPECT_TRUE(first->back.empty());
  EXPECT_EQ(Ids(first->forward), (std::vector<int32_t>{101, 102}));

  const mojom::WebViewHistoryPtr last = HistoryMenu(Entries(3), 2);
  EXPECT_EQ(Ids(last->back), (std::vector<int32_t>{101, 100}));
  EXPECT_TRUE(last->forward.empty());
}

}  // namespace
}  // namespace domicile
