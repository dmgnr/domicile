// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_BROWSER_WINDOW_LISTING_H_
#define COMPONENTS_DOMICILE_BROWSER_BROWSER_WINDOW_LISTING_H_

#include <string>
#include <vector>

#include "base/callback_list.h"
#include "base/functional/callback.h"

namespace domicile {

// A browser window as a capture tool lists it: the compositor serves these on
// ext-foreign-toplevel-list-v1 beside the native windows, each a capture
// source for the window's page alone. See docs/PORTALS.md.
struct ListedBrowserWindow {
  // The id `<webview window>` and a capture of the window use.
  std::string id;
  // The page's title. Empty when it has none.
  std::string title;
  // The title an Electron app gave its window, which the desktop shows
  // instead of the page's. Empty for none.
  std::string app_title;
  // The app window's id, or empty for any other window.
  std::string app_id;
  // The address it shows, or the one it is opening before its first
  // navigation commits.
  std::string url;
  // Whether it is a private window, in the off-the-record profile.
  bool off_the_record = false;
  // Whether it is an Electron app's view, part of a window rather than one:
  // a capture tool never lists it, and its app hears it closed only when it
  // leaves this list.
  bool view = false;
  // Whether it is an Electron app's window the app hid: open, its page
  // running, but out of sight, so a capture tool doesn't list it.
  bool hidden = false;
  // For a view a window holds and shows: that window's id, where the app
  // placed the view in the window's page, in its CSS pixels, and `stack`
  // from the bottom of the window's views. A capture of the window draws it
  // there. Empty and zero for anything else.
  std::string parent;
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
  int stack = 0;

  friend bool operator==(const ListedBrowserWindow&,
                         const ListedBrowserWindow&) = default;
};

// Sets the windows `source` lists, replacing the ones it listed before. An
// empty list takes them all away. //chrome calls it with one source per
// profile (see chrome/browser/domicile/domicile_browser_windows.h). UI
// thread only.
void ListBrowserWindows(const void* source,
                        std::vector<ListedBrowserWindow> windows);

// Every source's windows: the sources in the order each first listed one, and
// each source's in its own order.
std::vector<ListedBrowserWindow> ListedBrowserWindows();

// Runs `changed` after each ListBrowserWindows that changes
// ListedBrowserWindows(), until the subscription goes. UI thread only.
base::CallbackListSubscription WatchBrowserWindowListing(
    base::RepeatingClosure changed);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_BROWSER_WINDOW_LISTING_H_
