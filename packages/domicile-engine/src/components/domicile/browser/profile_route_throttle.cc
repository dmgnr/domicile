// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/profile_route_throttle.h"

#include <memory>
#include <optional>
#include <string>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/task/sequenced_task_runner.h"
#include "components/domicile/browser/browser_profiles.h"
#include "components/domicile/browser/web_view_guest.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"

namespace domicile {

// static
void ProfileRouteThrottle::Add(content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<ProfileRouteThrottle>(registry));
}

ProfileRouteThrottle::ProfileRouteThrottle(
    content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

ProfileRouteThrottle::~ProfileRouteThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult
ProfileRouteThrottle::WillStartRequest() {
  content::NavigationHandle& navigation = *navigation_handle();
  if (!IsUserNavigation(navigation.IsInPrimaryMainFrame(),
                        navigation.IsSameDocument(),
                        navigation.IsRendererInitiated(),
                        navigation.HasUserGesture(), navigation.IsPost(),
                        navigation.GetPageTransition())) {
    return PROCEED;
  }
  content::WebContents& contents = *navigation.GetWebContents();
  // A guest's navigation, so there is a guest; see Add.
  WebViewGuest& guest = *WebViewGuest::FromWebContents(&contents);
  // A shell's own <webview> is no window to move, a page with an opener stays
  // beside it, and a window's first page opened where routing put it.
  if (guest.window_id().empty() || contents.HasOpener() ||
      contents.GetController().GetLastCommittedEntry()->IsInitialEntry()) {
    return PROCEED;
  }
  const std::optional<std::string> profile = guest.ProfileToMoveTo(
      contents.GetLastCommittedURL(), navigation.GetURL());
  if (!profile.has_value()) {
    return PROCEED;
  }

  PageMove move;
  if (navigation.GetPageTransition() & ui::PAGE_TRANSITION_FORWARD_BACK) {
    move.kind = PageMove::Kind::kHistory;
    move.offset = navigation.GetNavigationEntryOffset();
  } else {
    move.kind = PageMove::Kind::kNavigate;
    move.url = navigation.GetURL();
    move.referrer = content::Referrer(navigation.GetReferrer());
    move.transition = navigation.GetPageTransition();
  }
  LOG(INFO) << "domicile: browser window " << guest.window_id()
            << " moves to browser profile " << *profile << " for "
            << navigation.GetURL().possibly_invalid_spec() << ".";
  // Not now: the move destroys this navigation's page, under whose stack
  // this runs.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&WebViewGuest::MoveToProfile,
                                guest.GetWeakPtr(), *profile, move));
  return CANCEL_AND_IGNORE;
}

const char* ProfileRouteThrottle::GetNameForLogging() {
  return "DomicileProfileRouteThrottle";
}

}  // namespace domicile
