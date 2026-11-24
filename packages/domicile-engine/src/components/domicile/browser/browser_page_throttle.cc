// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/browser_page_throttle.h"

#include <memory>

#include "base/logging.h"
#include "components/domicile/browser/app_navigation_throttle.h"
#include "components/domicile/browser/browser_pages.h"
#include "components/domicile/browser/profile_route_throttle.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/domicile/browser/web_view_url.h"
#include "components/domicile/browser/will_navigate_throttle.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"

namespace domicile {

// static
void BrowserPageThrottle::MaybeCreateAndAdd(
    content::NavigationThrottleRegistry& registry) {
  if (WebViewGuest::FromWebContents(
          registry.GetNavigationHandle().GetWebContents())) {
    registry.AddThrottle(std::make_unique<BrowserPageThrottle>(registry));
    // The app that owns the page decides before the shell, as Electron's
    // will-navigate does, on a page it may show.
    AppNavigationThrottle::Add(registry);
    // After these, so the shell is never asked about a page it may not show
    // or the app stopped.
    WillNavigateThrottle::Add(registry);
    // After the shell's answer, so a navigation it cancels moves nothing.
    ProfileRouteThrottle::Add(registry);
  }
}

BrowserPageThrottle::BrowserPageThrottle(
    content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

BrowserPageThrottle::~BrowserPageThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult
BrowserPageThrottle::WillStartRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult
BrowserPageThrottle::WillRedirectRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult BrowserPageThrottle::Check() {
  const GURL& url = navigation_handle()->GetURL();
  const WebViewGuest* guest =
      WebViewGuest::FromWebContents(navigation_handle()->GetWebContents());
  if (IsBrowserPage(url)) {
    // A guard script greps for this line to tell this refusal apart from an
    // ordinary load failure.
    LOG(INFO) << "domicile: a <webview> was refused a page Chrome serves "
                 "itself: "
              << url.spec();
    return CANCEL;
  } else if (!MayShowInWebView(url, guest->app_host())) {
    // A page's link or redirect into domicile://, which only an app's own
    // window may show, and only its own app. See
    // docs/architecture/APP-MODULES.md.
    LOG(WARNING) << "domicile: a <webview> may not show " << url.spec()
                 << "; it is canceled.";
    return CANCEL;
  } else {
    return PROCEED;
  }
}

const char* BrowserPageThrottle::GetNameForLogging() {
  return "DomicileBrowserPageThrottle";
}

}  // namespace domicile
