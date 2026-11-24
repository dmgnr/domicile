// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/page_matches.h"

#include <optional>

#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

TEST(PageMatchesTest, TheScriptCountsTheSelectorsMatches) {
  EXPECT_EQ(CountMatchesScript("[data-unread=true]"),
            u"document.querySelectorAll(\"[data-unread=true]\").length");
}

TEST(PageMatchesTest, NoSelectorEndsTheCall) {
  // A quote and a backslash are escaped, so the selector stays one string.
  EXPECT_EQ(CountMatchesScript("a\"), alert(1), (\"\\"),
            u"document.querySelectorAll("
            u"\"a\\\"), alert(1), (\\\"\\\\\").length");
}

TEST(PageMatchesTest, ANumberIsTheCount) {
  EXPECT_EQ(CountFrom(base::Value(3)), std::make_optional(3));
}

TEST(PageMatchesTest, AnythingElseIsNoAnswer) {
  // A script that threw, or a page that went, answers with no value.
  EXPECT_EQ(CountFrom(base::Value()), std::nullopt);
  EXPECT_EQ(CountFrom(base::Value("3")), std::nullopt);
}

TEST(PageMatchesTest, TheClickPressesTheSelectorsFirstMatch) {
  const std::u16string script = ClickMatchScript("tr [data-id=\"7\"]");
  EXPECT_TRUE(script.starts_with(u"((selector) => {"));
  EXPECT_TRUE(script.ends_with(u"})(\"tr [data-id=\\\"7\\\"]\")"));
}

TEST(PageMatchesTest, NoSelectorEndsTheClick) {
  // As for the count, the selector stays one string.
  EXPECT_TRUE(ClickMatchScript("a\"), alert(1), (\"")
                  .ends_with(u"})(\"a\\\"), alert(1), (\\\"\")"));
}

TEST(PageMatchesTest, ABooleanSaysWhetherItClicked) {
  EXPECT_EQ(ClickedFrom(base::Value(true)), std::make_optional(true));
  EXPECT_EQ(ClickedFrom(base::Value(false)), std::make_optional(false));
}

TEST(PageMatchesTest, AnythingElseIsNoClick) {
  EXPECT_EQ(ClickedFrom(base::Value()), std::nullopt);
  EXPECT_EQ(ClickedFrom(base::Value(1)), std::nullopt);
}

}  // namespace
}  // namespace domicile
