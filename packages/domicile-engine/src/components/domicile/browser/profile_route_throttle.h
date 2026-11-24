// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_PROFILE_ROUTE_THROTTLE_H_
#define COMPONENTS_DOMICILE_BROWSER_PROFILE_ROUTE_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

namespace content {
class NavigationThrottleRegistry;
}  // namespace content

namespace domicile {

// Moves a browser window's page to the profile of the site the user takes it
// to, as docs/architecture/BROWSER-PROFILES.md routes it: a link, the address
// bar, back or forward (IsUserNavigation) from a site of one profile to a
// site of another (BrowserWindowHost::ProfileToMoveTo).
//
// Cancels the navigation and has the host make the page again in the other
// profile under the same window, which then takes it (PageMove). A redirect
// never moves a page, so a sign-in finishes where it started; nor does a page
// with an opener, which stays beside it, or a window's first page, which it
// was opened where routing put it.
class ProfileRouteThrottle : public content::NavigationThrottle {
 public:
  // Adds a throttle to `registry`. The caller checks the navigation is in a
  // <webview> guest; see BrowserPageThrottle::MaybeCreateAndAdd.
  static void Add(content::NavigationThrottleRegistry& registry);

  explicit ProfileRouteThrottle(content::NavigationThrottleRegistry& registry);
  ProfileRouteThrottle(const ProfileRouteThrottle&) = delete;
  ProfileRouteThrottle& operator=(const ProfileRouteThrottle&) = delete;
  ~ProfileRouteThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  const char* GetNameForLogging() override;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_PROFILE_ROUTE_THROTTLE_H_
