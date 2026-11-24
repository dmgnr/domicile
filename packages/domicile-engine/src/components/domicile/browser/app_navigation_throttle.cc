// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/app_navigation_throttle.h"

#include <memory>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/task/bind_post_task.h"
#include "components/domicile/browser/web_view_guest.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"

namespace domicile {

// static
void AppNavigationThrottle::Add(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<AppNavigationThrottle>(registry));
}

AppNavigationThrottle::AppNavigationThrottle(
    content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

AppNavigationThrottle::~AppNavigationThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult
AppNavigationThrottle::WillStartRequest() {
  // The app's own loadURL, a history step and a reload ask nothing, as in
  // Electron.
  return navigation_handle()->IsRendererInitiated() ? Ask(/*redirect=*/false)
                                                    : PROCEED;
}

content::NavigationThrottle::ThrottleCheckResult
AppNavigationThrottle::WillRedirectRequest() {
  return Ask(/*redirect=*/true);
}

content::NavigationThrottle::ThrottleCheckResult AppNavigationThrottle::Ask(
    bool redirect) {
  content::NavigationHandle& navigation = *navigation_handle();
  // A guest's navigation, so there is a guest; see Add.
  const WebViewGuest::NavigationDeciding& deciding =
      WebViewGuest::FromWebContents(navigation.GetWebContents())
          ->navigation_deciding();
  if (deciding.is_null()) {
    return PROCEED;
  }
  // Posted: the throttle may only resume once it has deferred, and the app
  // may be gone, which answers at once.
  deciding.Run(
      navigation, redirect,
      base::BindPostTaskToCurrentDefault(base::BindOnce(
          &AppNavigationThrottle::Answered, weak_factory_.GetWeakPtr())));
  return DEFER;
}

void AppNavigationThrottle::Answered(bool proceed) {
  if (proceed) {
    Resume();
  } else {
    LOG(INFO) << "domicile: an app canceled its page's navigation to "
              << navigation_handle()->GetURL().possibly_invalid_spec() << ".";
    CancelDeferredNavigation(CANCEL);
  }
}

const char* AppNavigationThrottle::GetNameForLogging() {
  return "DomicileAppNavigationThrottle";
}

}  // namespace domicile
