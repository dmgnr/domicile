// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_DESK_TABS_H_
#define COMPONENTS_DOMICILE_BROWSER_DESK_TABS_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/containers/span.h"

namespace domicile {

// The browser-free logic behind chrome.tabs on a desk: the active <webview>
// tab, refused calls, and query matching. See
// docs/architecture/EXTENSIONS.md#tabs. The window controller is in
// //chrome/browser/domicile/domicile_desk.h.

// The error message for every refused call.
inline constexpr char kNotOnADesk[] = "not supported on a Domicile desk";

// chrome.windows.WINDOW_ID_CURRENT. Copied from extension_misc because this
// target does not depend on //extensions.
inline constexpr int kCurrentWindowId = -2;

// The chrome.tabs calls a desk refuses, by ExtensionFunctionRegistry name.
//
// Moves, groups, splits, duplicates and discards have no desktop meaning.
// Reporting success without acting would hide the failure from the extension.
base::span<const char* const> RefusedOnDesk();
bool IsRefusedOnDesk(std::string_view function_name);

// The zoom factor to apply for tabs.setZoom's `zoomFactor`, or nothing if
// refused. 0 or less means `default_factor`, as in Chrome. Values outside
// [minimum, maximum] (Blink's zoom range, which <webview> setZoom also uses)
// are refused.
std::optional<double> DeskZoomFactor(double asked,
                                     double default_factor,
                                     double minimum,
                                     double maximum);

// Whether tabs.setZoomSettings takes `mode` with `scope` ("" when omitted). As
// in Chrome, only automatic zoom can be per origin.
bool DeskTakesZoomSettings(std::string_view mode, std::string_view scope);

// Whether a focused guest showing `scheme` becomes the active tab. Extension
// pages do not: a popup is also a <webview>, and would otherwise find itself
// in its own tabs.query.
bool TakesActiveOnFocus(std::string_view scheme);

// The windows.create fields that decide whether a desk opens the window. Each
// string is "" when omitted.
struct DeskWindowCreate {
  std::string type;
  int urls = 0;
  bool tab_id = false;
  bool incognito = false;
  std::string state;
  bool set_self_as_opener = false;
};

// Whether a desk opens the window `create` asks for. Only a popup (`popup` or
// the deprecated `panel`) with one address in the normal state, as extensions
// use for their own pages such as Bitwarden's sign-in.
//
// Normal windows are refused because tabs.create covers them. Tab moves,
// openers, multiple addresses and incognito are refused because the shell
// cannot create them. Bounds are ignored; the shell decides size and position.
bool DeskOpensWindow(const DeskWindowCreate& create);

// The desk's tabs by SessionTabHelper id. Creation order gives the index;
// focus order gives the active tab.
class DeskTabs {
 public:
  DeskTabs();
  DeskTabs(const DeskTabs&) = delete;
  DeskTabs& operator=(const DeskTabs&) = delete;
  ~DeskTabs();

  // A new tab is ordered behind every focused tab.
  void Add(int tab_id);
  void Remove(int tab_id);
  void Focus(int tab_id);

  // The last focused tab, else the first created, else nothing.
  std::optional<int> Active() const;

  int IndexOf(int tab_id) const;
  const std::vector<int>& InCreationOrder() const { return created_; }

 private:
  std::vector<int> created_;
  // Least recently focused first; the last is the active tab.
  std::vector<int> focused_;
};

// The tab fields a query compares. `active` and `index` are relative to the
// tab's window: the desk, or an extension's popup window.
struct DeskTabFacts {
  bool active = false;
  int index = -1;
  int window_id = -1;
  bool audible = false;
  bool muted = false;
  std::string status;
  // `normal` for the desk's, `popup` for a popup window's.
  std::string window_type;
  // Whether the tab's window is the caller's current window, and the last
  // focused window.
  bool in_current_window = false;
  bool in_last_focused_window = false;
};

// chrome.tabs.query's queryInfo without `url` and `title`, which need
// URLPatternSet and scrubbing from //chrome.
struct DeskTabQuery {
  DeskTabQuery();
  DeskTabQuery(const DeskTabQuery&);
  DeskTabQuery& operator=(const DeskTabQuery&);
  ~DeskTabQuery();

  std::optional<bool> active;
  std::optional<bool> highlighted;
  std::optional<bool> current_window;
  std::optional<bool> last_focused_window;
  std::optional<bool> pinned;
  std::optional<bool> audible;
  std::optional<bool> muted;
  std::optional<bool> discarded;
  std::optional<bool> frozen;
  std::optional<bool> auto_discardable;
  std::optional<int> window_id;
  std::optional<int> index;
  std::optional<int> group_id;
  std::optional<int> split_view_id;
  std::optional<std::string> status;
  std::optional<std::string> window_type;
};

// Whether `query` matches `tab`. A desk tab is highlighted when active, and is
// never pinned, grouped, split, frozen or discarded.
bool DeskTabMatches(const DeskTabQuery& query, const DeskTabFacts& tab);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_DESK_TABS_H_
