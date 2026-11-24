// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_BROWSER_PAGE_THROTTLE_H_
#define COMPONENTS_DOMICILE_BROWSER_BROWSER_PAGE_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

namespace content {
class NavigationThrottleRegistry;
}  // namespace content

namespace domicile {

// Stops a <webview> guest from loading Chrome's own pages (see IsBrowserPage),
// or a domicile:// address it is not pinned to (see MayShowInWebView).
//
// A throttle catches every route in: `src`, links, redirects, and extension
// tabs.create/tabs.update.
//
// Cancels rather than blocks, so the guest stays on its current page. Blocking
// commits an error page, and committing one for a WebUI address in a guest hits
// a fatal CHECK in the browser process.
//
// Guests only: the shell's own window is trusted.
class BrowserPageThrottle : public content::NavigationThrottle {
 public:
  // Adds a throttle to `registry` if the navigation is in a <webview> guest,
  // a WillNavigateThrottle after it, and a ProfileRouteThrottle after that.
  static void MaybeCreateAndAdd(content::NavigationThrottleRegistry& registry);

  explicit BrowserPageThrottle(content::NavigationThrottleRegistry& registry);
  BrowserPageThrottle(const BrowserPageThrottle&) = delete;
  BrowserPageThrottle& operator=(const BrowserPageThrottle&) = delete;
  ~BrowserPageThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;
  const char* GetNameForLogging() override;

 private:
  // Cancels a Chrome page, and a domicile:// address the guest may not show.
  ThrottleCheckResult Check();
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_BROWSER_PAGE_THROTTLE_H_
