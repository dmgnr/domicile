// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/desk_tabs.h"

#include <optional>
#include <vector>

#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

TEST(DeskTabsTest, TheActiveTabIsTheOneThatLastHadFocus) {
  DeskTabs tabs;
  tabs.Add(1);
  tabs.Add(2);
  tabs.Add(3);
  tabs.Focus(3);
  tabs.Focus(1);
  EXPECT_EQ(tabs.Active(), 1);
  // Index order is creation order, regardless of focus.
  EXPECT_EQ(tabs.InCreationOrder(), (std::vector<int>{1, 2, 3}));
  EXPECT_EQ(tabs.IndexOf(3), 2);
}

TEST(DeskTabsTest, BeforeAnyFocusTheFirstMadeIsActive) {
  // Unfocused tabs sort behind focused ones, so the first window stays active
  // until another is focused.
  DeskTabs tabs;
  EXPECT_EQ(tabs.Active(), std::nullopt);
  tabs.Add(1);
  tabs.Add(2);
  EXPECT_EQ(tabs.Active(), 1);
  tabs.Focus(2);
  tabs.Add(3);
  EXPECT_EQ(tabs.Active(), 2);
}

TEST(DeskTabsTest, ClosingTheActiveTabActivatesTheOneFocusedBeforeIt) {
  DeskTabs tabs;
  tabs.Add(1);
  tabs.Add(2);
  tabs.Add(3);
  tabs.Focus(2);
  tabs.Focus(3);
  tabs.Remove(3);
  EXPECT_EQ(tabs.Active(), 2);
  EXPECT_EQ(tabs.InCreationOrder(), (std::vector<int>{1, 2}));
  tabs.Remove(2);
  tabs.Remove(1);
  EXPECT_EQ(tabs.Active(), std::nullopt);
}

TEST(DeskTabsTest, AnExtensionPageNeverTakesTheActiveTab) {
  // Otherwise a popup's tabs.query would return the popup itself.
  EXPECT_TRUE(TakesActiveOnFocus("https"));
  EXPECT_TRUE(TakesActiveOnFocus("file"));
  EXPECT_FALSE(TakesActiveOnFocus("chrome-extension"));
}

TEST(DeskTabsTest, WhatHasNoDesktopMeaningIsRefused) {
  for (const char* refused :
       {"tabs.move", "tabs.group", "tabs.ungroup", "tabs.discard",
        "tabs.duplicate", "tabs.createSplit", "tabs.unsplit"}) {
    EXPECT_TRUE(IsRefusedOnDesk(refused)) << refused;
  }
  for (const char* answered :
       {"tabs.query", "tabs.get", "tabs.update", "tabs.create", "tabs.remove",
        "tabs.reload", "tabs.setZoom", "tabs.getZoom", "tabs.setZoomSettings",
        "tabs.getZoomSettings", "windows.get", "windows.update",
        "windows.create", "windows.remove"}) {
    EXPECT_FALSE(IsRefusedOnDesk(answered)) << answered;
  }
  EXPECT_EQ(RefusedOnDesk().size(), 7u);
}

DeskWindowCreate APopup() {
  return DeskWindowCreate{.type = "popup", .urls = 1};
}

TEST(DeskTabsTest, APopupWindowAtOneAddressIsOpened) {
  // Bitwarden's sign-in: windows.create({type: "popup", url, width, height,
  // focused}). The shell handles the size.
  EXPECT_TRUE(DeskOpensWindow(APopup()));
  // Chrome opens the deprecated `panel` as a popup.
  DeskWindowCreate panel = APopup();
  panel.type = "panel";
  EXPECT_TRUE(DeskOpensWindow(panel));
  DeskWindowCreate normal_state = APopup();
  normal_state.state = "normal";
  EXPECT_TRUE(DeskOpensWindow(normal_state));
}

TEST(DeskTabsTest, AWindowThatIsNotAPopupAtOneAddressIsRefused) {
  // tabs.create covers normal windows. The shell cannot create the rest.
  DeskWindowCreate normal = APopup();
  normal.type = "normal";
  EXPECT_FALSE(DeskOpensWindow(normal));
  DeskWindowCreate untyped = APopup();
  untyped.type = "";
  EXPECT_FALSE(DeskOpensWindow(untyped));
  DeskWindowCreate nowhere = APopup();
  nowhere.urls = 0;
  EXPECT_FALSE(DeskOpensWindow(nowhere));
  DeskWindowCreate two = APopup();
  two.urls = 2;
  EXPECT_FALSE(DeskOpensWindow(two));
  DeskWindowCreate moved = APopup();
  moved.tab_id = true;
  EXPECT_FALSE(DeskOpensWindow(moved));
  DeskWindowCreate incognito = APopup();
  incognito.incognito = true;
  EXPECT_FALSE(DeskOpensWindow(incognito));
  DeskWindowCreate opened = APopup();
  opened.set_self_as_opener = true;
  EXPECT_FALSE(DeskOpensWindow(opened));
  DeskWindowCreate maximized = APopup();
  maximized.state = "maximized";
  EXPECT_FALSE(DeskOpensWindow(maximized));
}

TEST(DeskTabsTest, ZeroZoomsToTheDefaultAndOutOfRangeIsRefused) {
  // 0 means the default, as in Chrome. Values outside <webview>'s zoom range
  // are refused.
  EXPECT_EQ(DeskZoomFactor(1.5, 1.25, 0.25, 5.0), 1.5);
  EXPECT_EQ(DeskZoomFactor(0, 1.25, 0.25, 5.0), 1.25);
  EXPECT_EQ(DeskZoomFactor(-1, 1.25, 0.25, 5.0), 1.25);
  EXPECT_EQ(DeskZoomFactor(0.25, 1.0, 0.25, 5.0), 0.25);
  EXPECT_EQ(DeskZoomFactor(5.0, 1.0, 0.25, 5.0), 5.0);
  EXPECT_EQ(DeskZoomFactor(0.1, 1.0, 0.25, 5.0), std::nullopt);
  EXPECT_EQ(DeskZoomFactor(10, 1.0, 0.25, 5.0), std::nullopt);
}

TEST(DeskTabsTest, OnlyAutomaticZoomIsPerOrigin) {
  // As in Chrome: every mode zooms per tab, and automatic per origin too. ""
  // means omitted.
  EXPECT_TRUE(DeskTakesZoomSettings("", ""));
  EXPECT_TRUE(DeskTakesZoomSettings("automatic", "per-origin"));
  EXPECT_TRUE(DeskTakesZoomSettings("", "per-origin"));
  EXPECT_TRUE(DeskTakesZoomSettings("automatic", "per-tab"));
  EXPECT_TRUE(DeskTakesZoomSettings("manual", ""));
  EXPECT_TRUE(DeskTakesZoomSettings("manual", "per-tab"));
  EXPECT_TRUE(DeskTakesZoomSettings("disabled", "per-tab"));
  EXPECT_FALSE(DeskTakesZoomSettings("manual", "per-origin"));
  EXPECT_FALSE(DeskTakesZoomSettings("disabled", "per-origin"));
}

DeskTabFacts Facts() {
  return DeskTabFacts{.active = true,
                      .index = 1,
                      .window_id = 40,
                      .audible = false,
                      .muted = false,
                      .status = "complete",
                      .window_type = "normal",
                      .in_current_window = true,
                      .in_last_focused_window = true};
}

// The single tab of an extension's popup window, queried from outside it.
DeskTabFacts PopupFacts() {
  return DeskTabFacts{.active = true,
                      .index = 0,
                      .window_id = 41,
                      .audible = false,
                      .muted = false,
                      .status = "complete",
                      .window_type = "popup",
                      .in_current_window = false,
                      .in_last_focused_window = false};
}

TEST(DeskTabsTest, AnEmptyQueryMatchesEveryTab) {
  EXPECT_TRUE(DeskTabMatches(DeskTabQuery(), Facts()));
}

TEST(DeskTabsTest, ThePopupQueryMatchesTheActiveTabOnly) {
  // tabs.query({active: true, currentWindow: true}), the common popup query.
  DeskTabQuery query;
  query.active = true;
  query.current_window = true;
  EXPECT_TRUE(DeskTabMatches(query, Facts()));
  DeskTabFacts background = Facts();
  background.active = false;
  EXPECT_FALSE(DeskTabMatches(query, background));

  DeskTabQuery elsewhere;
  elsewhere.current_window = false;
  EXPECT_FALSE(DeskTabMatches(elsewhere, Facts()));
}

TEST(DeskTabsTest, APopupWindowsTabIsNotTheDesksActiveTab) {
  // It is active only in its own window. From the desk, the page under the
  // popup stays the active tab.
  DeskTabQuery query;
  query.active = true;
  query.current_window = true;
  EXPECT_FALSE(DeskTabMatches(query, PopupFacts()));
  DeskTabFacts from_inside = PopupFacts();
  from_inside.in_current_window = true;
  EXPECT_TRUE(DeskTabMatches(query, from_inside));

  DeskTabQuery last_focused;
  last_focused.last_focused_window = true;
  EXPECT_FALSE(DeskTabMatches(last_focused, PopupFacts()));
  DeskTabFacts focused = PopupFacts();
  focused.in_last_focused_window = true;
  EXPECT_TRUE(DeskTabMatches(last_focused, focused));
}

TEST(DeskTabsTest, AWindowIsNamedByItsIdOrAsTheCurrentOne) {
  DeskTabQuery current;
  current.window_id = kCurrentWindowId;
  EXPECT_TRUE(DeskTabMatches(current, Facts()));
  EXPECT_FALSE(DeskTabMatches(current, PopupFacts()));
  DeskTabQuery by_id;
  by_id.window_id = 40;
  EXPECT_TRUE(DeskTabMatches(by_id, Facts()));
  EXPECT_FALSE(DeskTabMatches(by_id, PopupFacts()));
  by_id.window_id = 41;
  EXPECT_FALSE(DeskTabMatches(by_id, Facts()));
  EXPECT_TRUE(DeskTabMatches(by_id, PopupFacts()));
}

TEST(DeskTabsTest, AWindowTypeIsTheTabsWindows) {
  // Bitwarden finds its sign-in window with tabs.query({windowType: "popup"}).
  DeskTabQuery popup;
  popup.window_type = "popup";
  EXPECT_FALSE(DeskTabMatches(popup, Facts()));
  EXPECT_TRUE(DeskTabMatches(popup, PopupFacts()));
  DeskTabQuery normal;
  normal.window_type = "normal";
  EXPECT_TRUE(DeskTabMatches(normal, Facts()));
  EXPECT_FALSE(DeskTabMatches(normal, PopupFacts()));
}

TEST(DeskTabsTest, WhatADeskTabNeverIsMatchesNothing) {
  // Desk tabs are never pinned, grouped, split or discarded.
  DeskTabQuery pinned;
  pinned.pinned = true;
  EXPECT_FALSE(DeskTabMatches(pinned, Facts()));
  pinned.pinned = false;
  EXPECT_TRUE(DeskTabMatches(pinned, Facts()));
  DeskTabQuery grouped;
  grouped.group_id = 7;
  EXPECT_FALSE(DeskTabMatches(grouped, Facts()));
  grouped.group_id = -1;
  EXPECT_TRUE(DeskTabMatches(grouped, Facts()));
  DeskTabQuery discarded;
  discarded.discarded = true;
  EXPECT_FALSE(DeskTabMatches(discarded, Facts()));
}

TEST(DeskTabsTest, TheTabsOwnStateIsCompared) {
  DeskTabQuery query;
  query.index = 0;
  EXPECT_FALSE(DeskTabMatches(query, Facts()));
  query.index = 1;
  query.status = "loading";
  EXPECT_FALSE(DeskTabMatches(query, Facts()));
  query.status = "complete";
  query.muted = true;
  EXPECT_FALSE(DeskTabMatches(query, Facts()));
  query.muted = false;
  query.highlighted = true;
  EXPECT_TRUE(DeskTabMatches(query, Facts()));
}

}  // namespace
}  // namespace domicile
