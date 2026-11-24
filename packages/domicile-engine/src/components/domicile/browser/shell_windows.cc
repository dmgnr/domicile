// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_windows.h"

#include <algorithm>
#include <utility>

#include "base/check.h"

namespace domicile {
namespace {

// Whether `id` is one of `ids`. `base/containers/contains.h` is not in the
// pinned tree.
bool Holds(const std::vector<int64_t>& ids, int64_t id) {
  return std::ranges::find(ids, id) != ids.end();
}

}  // namespace

ShellWindowPlan ShellWindowsFor(const std::vector<display::Display>& displays,
                                const std::vector<int64_t>& windowed) {
  ShellWindowPlan plan;
  for (const display::Display& display : displays) {
    if (!Holds(windowed, display.id())) {
      plan.open.push_back(display.id());
    }
  }
  for (int64_t held : windowed) {
    // A linear scan is cheaper than a set for a handful of monitors.
    const bool still_here =
        std::ranges::any_of(displays, [held](const display::Display& display) {
          return display.id() == held;
        });
    if (!still_here) {
      plan.close.push_back(held);
    }
  }
  // Pair the two in order: a window moves where a new one would open.
  const size_t moved = std::min(plan.open.size(), plan.close.size());
  for (size_t index = 0; index < moved; ++index) {
    plan.move.push_back(
        ShellWindowMove{.from = plan.close[index], .to = plan.open[index]});
  }
  plan.open.erase(plan.open.begin(), plan.open.begin() + moved);
  plan.close.erase(plan.close.begin(), plan.close.begin() + moved);
  // Keep the last window if nothing replaces it: closing it exits the browser.
  // A closed laptop lid with no external monitor reports no displays.
  if (plan.open.empty() && plan.close.size() == windowed.size() &&
      !windowed.empty()) {
    plan.close.erase(plan.close.begin());
  }
  return plan;
}

ShellWindowPlaces::ShellWindowPlaces() = default;

ShellWindowPlaces::~ShellWindowPlaces() = default;

void ShellWindowPlaces::Place(uintptr_t window, int64_t display) {
  placed_.insert_or_assign(window, Record{.display = display, .seen = false});
}

void ShellWindowPlaces::Move(uintptr_t window, int64_t display) {
  const auto known = placed_.find(window);
  CHECK(known != placed_.end()) << "moved a shell window nobody placed";
  known->second.display = display;
}

std::vector<int64_t> ShellWindowPlaces::Update(
    const std::vector<SightedShellWindow>& live,
    const std::vector<uintptr_t>& loading) {
  base::flat_map<uintptr_t, Record> still_here;
  std::vector<int64_t> windowed;
  windowed.reserve(live.size());
  for (const SightedShellWindow& one : live) {
    // Prefer the recorded display: mid-hotplug, a window's bounds may point at
    // the wrong one.
    const auto known = placed_.find(one.window);
    const int64_t on =
        known == placed_.end() ? one.nearest : known->second.display;
    still_here.insert_or_assign(one.window,
                                Record{.display = on, .seen = true});
    windowed.push_back(on);
  }
  for (uintptr_t window : loading) {
    const auto known = placed_.find(window);
    if (known != placed_.end() && !known->second.seen) {
      still_here.insert_or_assign(window, known->second);
    }
  }
  // Replace, not merge, to drop windows the browser no longer has.
  placed_ = std::move(still_here);
  return windowed;
}

int64_t ShellWindowPlaces::Of(uintptr_t window) const {
  const auto known = placed_.find(window);
  return known == placed_.end() ? display::kInvalidDisplayId
                                : known->second.display;
}

std::vector<ShellWindowBounds> ShellWindowsToFit(
    const ShellWindowPlaces& places,
    const std::vector<ShellWindowBounds>& windows,
    const std::vector<display::Display>& displays) {
  std::vector<ShellWindowBounds> misfits;
  for (const ShellWindowBounds& one : windows) {
    const auto on = std::ranges::find(displays, places.Of(one.window),
                                      &display::Display::id);
    if (on != displays.end() && on->bounds() != one.pixels) {
      misfits.push_back(
          ShellWindowBounds{.window = one.window, .pixels = on->bounds()});
    }
  }
  return misfits;
}

}  // namespace domicile
