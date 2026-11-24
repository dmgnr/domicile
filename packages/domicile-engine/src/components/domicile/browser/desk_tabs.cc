// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/desk_tabs.h"

#include <algorithm>
#include <array>
#include <iterator>

#include "base/check.h"
#include "base/check_op.h"

namespace domicile {
namespace {

constexpr auto kRefused = std::to_array<const char*>({
    "tabs.move",
    "tabs.group",
    "tabs.ungroup",
    "tabs.discard",
    "tabs.duplicate",
    "tabs.createSplit",
    "tabs.unsplit",
});

// Whether `asked` allows `is`; an absent filter allows anything.
bool Allows(const std::optional<bool>& asked, bool is) {
  return !asked.has_value() || *asked == is;
}

}  // namespace

base::span<const char* const> RefusedOnDesk() {
  return kRefused;
}

bool IsRefusedOnDesk(std::string_view function_name) {
  return std::ranges::any_of(kRefused, [function_name](const char* refused) {
    return function_name == refused;
  });
}

std::optional<double> DeskZoomFactor(double asked,
                                     double default_factor,
                                     double minimum,
                                     double maximum) {
  if (asked <= 0) {
    return default_factor;
  }
  return asked >= minimum && asked <= maximum ? std::optional(asked)
                                              : std::nullopt;
}

bool DeskTakesZoomSettings(std::string_view mode, std::string_view scope) {
  return scope != "per-origin" || mode.empty() || mode == "automatic";
}

bool TakesActiveOnFocus(std::string_view scheme) {
  return scheme != "chrome-extension";
}

bool DeskOpensWindow(const DeskWindowCreate& create) {
  return (create.type == "popup" || create.type == "panel") &&
         create.urls == 1 && !create.tab_id && !create.incognito &&
         !create.set_self_as_opener &&
         (create.state.empty() || create.state == "normal");
}

DeskTabs::DeskTabs() = default;
DeskTabs::~DeskTabs() = default;

void DeskTabs::Add(int tab_id) {
  CHECK(!std::ranges::contains(created_, tab_id));
  created_.push_back(tab_id);
  focused_.insert(focused_.begin(), tab_id);
}

void DeskTabs::Remove(int tab_id) {
  CHECK_EQ(std::erase(created_, tab_id), 1u);
  CHECK_EQ(std::erase(focused_, tab_id), 1u);
}

void DeskTabs::Focus(int tab_id) {
  CHECK_EQ(std::erase(focused_, tab_id), 1u);
  focused_.push_back(tab_id);
}

std::optional<int> DeskTabs::Active() const {
  return focused_.empty() ? std::nullopt : std::optional(focused_.back());
}

int DeskTabs::IndexOf(int tab_id) const {
  const auto found = std::ranges::find(created_, tab_id);
  CHECK(found != created_.end());
  return static_cast<int>(std::distance(created_.begin(), found));
}

DeskTabQuery::DeskTabQuery() = default;
DeskTabQuery::DeskTabQuery(const DeskTabQuery&) = default;
DeskTabQuery& DeskTabQuery::operator=(const DeskTabQuery&) = default;
DeskTabQuery::~DeskTabQuery() = default;

bool DeskTabMatches(const DeskTabQuery& query, const DeskTabFacts& tab) {
  const bool window_matches =
      !query.window_id.has_value() ||
      (*query.window_id == kCurrentWindowId
           ? tab.in_current_window
           : *query.window_id < 0 || *query.window_id == tab.window_id);
  return window_matches && Allows(query.active, tab.active) &&
         Allows(query.highlighted, tab.active) &&
         Allows(query.current_window, tab.in_current_window) &&
         Allows(query.last_focused_window, tab.in_last_focused_window) &&
         Allows(query.pinned, false) && Allows(query.audible, tab.audible) &&
         Allows(query.muted, tab.muted) && Allows(query.discarded, false) &&
         Allows(query.frozen, false) && Allows(query.auto_discardable, true) &&
         (!query.index.has_value() || *query.index == tab.index) &&
         (!query.group_id.has_value() || *query.group_id == -1) &&
         (!query.split_view_id.has_value() || *query.split_view_id == -1) &&
         (!query.status.has_value() || *query.status == tab.status) &&
         (!query.window_type.has_value() ||
          *query.window_type == tab.window_type);
}

}  // namespace domicile
