// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_APP_NAVIGATION_THROTTLE_H_
#define COMPONENTS_DOMICILE_BROWSER_APP_NAVIGATION_THROTTLE_H_

#include "base/memory/weak_ptr.h"
#include "content/public/browser/navigation_throttle.h"

namespace content {
class NavigationThrottleRegistry;
}  // namespace content

namespace domicile {

// Holds a guest's navigation while the app that owns its page decides on it:
// each navigation the page starts itself, and each server redirect, as
// Electron's will-navigate, will-frame-navigate and will-redirect can prevent
// them. Only for a guest with WebViewGuest::DecideNavigationsWith.
//
// Cancels as Electron does, so the frame stays on its document and commits no
// error page.
class AppNavigationThrottle : public content::NavigationThrottle {
 public:
  // Adds a throttle to `registry`. The caller checks the navigation is in a
  // <webview> guest; see BrowserPageThrottle::MaybeCreateAndAdd.
  static void Add(content::NavigationThrottleRegistry& registry);

  explicit AppNavigationThrottle(content::NavigationThrottleRegistry& registry);
  AppNavigationThrottle(const AppNavigationThrottle&) = delete;
  AppNavigationThrottle& operator=(const AppNavigationThrottle&) = delete;
  ~AppNavigationThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;
  const char* GetNameForLogging() override;

 private:
  // Asks the app, or proceeds when the guest's page is not an app's.
  ThrottleCheckResult Ask(bool redirect);
  // Resumes or cancels the deferred navigation on the app's answer.
  void Answered(bool proceed);

  base::WeakPtrFactory<AppNavigationThrottle> weak_factory_{this};
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_APP_NAVIGATION_THROTTLE_H_
