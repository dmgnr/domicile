// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_desk_functions.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/pattern.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "chrome/browser/domicile/domicile_extension_tray.h"
#include "chrome/browser/domicile/domicile_window_controller.h"
#include "chrome/browser/extensions/api/side_panel/side_panel_service.h"
#include "chrome/browser/extensions/api/tabs/tabs_constants.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/common/extensions/api/side_panel.h"
#include "chrome/common/extensions/api/tabs.h"
#include "chrome/common/extensions/api/windows.h"
#include "components/domicile/browser/desk_tabs.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/zoom/zoom_controller.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_function.h"
#include "extensions/browser/extension_function_registry.h"
#include "extensions/common/constants.h"
#include "extensions/common/error_utils.h"
#include "extensions/common/extension.h"
#include "extensions/common/permissions/permissions_data.h"
#include "extensions/common/url_pattern.h"
#include "extensions/common/url_pattern_set.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "url/gurl.h"

namespace domicile {
namespace {

namespace tabs = extensions::api::tabs;
namespace windows = extensions::api::windows;
using extensions::ExtensionTabUtil;

// Matches Chrome's message, so extensions that match on it still work.
constexpr char kTabNotFoundError[] = "No tab with id: *.";

// Returned when the desk has no tab to ask the shell through.
constexpr char kNoWindowToAskError[] =
    "No browser window on this Domicile desk to ask the shell through.";

// action.openPopup's errors, in Chrome's words.
constexpr char kNoActiveWindowFound[] =
    "Could not find an active browser window.";
constexpr char kNoToolbar[] = "Browser window has no toolbar.";
constexpr char kNoActivePopup[] =
    "Extension does not have a popup on the active tab.";
constexpr char kFailedToOpenPopup[] = "Failed to open popup.";

// Returned for a zoom factor outside blink's browser range, which the
// <webview> element's own setZoom also enforces.
constexpr char kZoomOutOfRangeError[] =
    "Zoom factor * is outside the range a Domicile desk zooms to.";

// The desk of the calling profile, or null.
DomicileWindowController* DeskOf(ExtensionFunction& function) {
  return DomicileWindowController::Find(function.browser_context());
}

// The desks `function` sees: its profile's, and its private profile's too for
// an extension allowed in private windows. See
// DomicileWindowController::Visible.
std::vector<DomicileWindowController*> DesksOf(ExtensionFunction& function) {
  return DomicileWindowController::Visible(
      function.browser_context(), function.include_incognito_information());
}

// Of DesksOf, the desk whose tab last took focus, or null with no desk.
DomicileWindowController* LastFocusedDeskOf(ExtensionFunction& function) {
  return DomicileWindowController::LastFocusedDesk(
      function.browser_context(), function.include_incognito_information());
}

// The desk holding the caller's tab, or for a caller with no tab (such as a
// service worker) the last focused desk. Null with no desk.
DomicileWindowController* CurrentDeskOf(ExtensionFunction& function) {
  content::WebContents* sender = function.GetSenderWebContents();
  if (sender != nullptr) {
    for (DomicileWindowController* desk : DesksOf(function)) {
      if (desk->WindowOf(*sender) != nullptr) {
        return desk;
      }
    }
  }
  return LastFocusedDeskOf(function);
}

// chrome.windows' "current" window: the caller's tab's window, or for a
// caller with no tab the last focused desk's own window. Null with no desk.
DomicileWindowController* CurrentWindowOf(ExtensionFunction& function) {
  DomicileWindowController* desk = CurrentDeskOf(function);
  if (desk == nullptr) {
    return nullptr;
  }
  content::WebContents* sender = function.GetSenderWebContents();
  DomicileWindowController* window =
      sender == nullptr ? nullptr : desk->WindowOf(*sender);
  return window == nullptr ? desk : window;
}

// The window `window_id` names, including kCurrentWindowId, or null.
DomicileWindowController* WindowNamed(ExtensionFunction& function,
                                      int window_id) {
  if (window_id == kCurrentWindowId) {
    return CurrentWindowOf(function);
  }
  for (DomicileWindowController* desk : DesksOf(function)) {
    if (DomicileWindowController* window = desk->WindowWithId(window_id)) {
      return window;
    }
  }
  return nullptr;
}

std::string WindowNotFound(int window_id) {
  return extensions::ErrorUtils::FormatErrorMessage(
      ExtensionTabUtil::kWindowNotFoundError, base::NumberToString(window_id));
}

// The tab with `tab_id` in any window, or the current window's active tab
// when `tab_id` is unset (Chrome's default). Null if neither exists.
content::WebContents* TabOrActive(ExtensionFunction& function,
                                  std::optional<int> tab_id) {
  if (!tab_id.has_value()) {
    DomicileWindowController* current = CurrentWindowOf(function);
    return current == nullptr ? nullptr : current->GetActiveTab();
  }
  for (DomicileWindowController* desk : DesksOf(function)) {
    if (DomicileWindowController* window = desk->WindowWithTab(*tab_id)) {
      return window->TabWithId(*tab_id);
    }
  }
  return nullptr;
}

std::string TabNotFound(std::optional<int> tab_id) {
  return extensions::ErrorUtils::FormatErrorMessage(
      kTabNotFoundError, base::NumberToString(tab_id.value_or(-1)));
}

WebViewGuest& GuestOf(content::WebContents& tab) {
  WebViewGuest* guest = WebViewGuest::FromWebContents(&tab);
  CHECK(guest);
  return *guest;
}

// The profile's default zoom, which `tabs.setZoom(id, 0)` restores.
double DefaultZoomFactor(content::WebContents& tab) {
  return blink::ZoomLevelToZoomFactor(
      content::HostZoomMap::GetForWebContents(&tab)->GetDefaultZoomLevel());
}

// The ZoomController mode tabs.setZoomSettings asks for, as Chrome's maps it.
// DeskTakesZoomSettings has already refused a per-origin mode that is not
// automatic.
zoom::ZoomController::ZoomMode ZoomModeFor(const tabs::ZoomSettings& settings) {
  switch (settings.mode) {
    case tabs::ZoomSettingsMode::kNone:
    case tabs::ZoomSettingsMode::kAutomatic:
      return settings.scope == tabs::ZoomSettingsScope::kPerTab
                 ? zoom::ZoomController::ZOOM_MODE_ISOLATED
                 : zoom::ZoomController::ZOOM_MODE_DEFAULT;
    case tabs::ZoomSettingsMode::kManual:
      return zoom::ZoomController::ZOOM_MODE_MANUAL;
    case tabs::ZoomSettingsMode::kDisabled:
      return zoom::ZoomController::ZOOM_MODE_DISABLED;
  }
}

base::Value TabValue(ExtensionFunction& function, content::WebContents& tab) {
  return base::Value(
      ExtensionTabUtil::CreateTabObject(
          &tab,
          ExtensionTabUtil::GetScrubTabBehavior(
              function.extension(), function.source_context_type(), &tab),
          function.extension())
          .ToValue());
}

// Converts queryInfo for //components/domicile:desk_tabs.
DeskTabQuery AsDeskTabQuery(const tabs::Query::Params::QueryInfo& info) {
  DeskTabQuery query;
  query.active = info.active;
  query.highlighted = info.highlighted;
  query.current_window = info.current_window;
  query.last_focused_window = info.last_focused_window;
  query.pinned = info.pinned;
  query.audible = info.audible;
  query.muted = info.muted;
  query.discarded = info.discarded;
  query.frozen = info.frozen;
  query.auto_discardable = info.auto_discardable;
  query.window_id = info.window_id;
  query.index = info.index;
  query.group_id = info.group_id;
  query.split_view_id = info.split_view_id;
  if (info.status != tabs::TabStatus::kNone) {
    query.status = std::string(tabs::ToString(info.status));
  }
  if (info.window_type != tabs::WindowType::kNone) {
    query.window_type = std::string(tabs::ToString(info.window_type));
  }
  return query;
}

// The facts a query compares about `tab`, relative to `current` and the
// last focused window.
DeskTabFacts FactsOf(DomicileWindowController& window,
                     DomicileWindowController& current,
                     DomicileWindowController& last_focused,
                     content::WebContents& tab) {
  return DeskTabFacts{
      .active = window.IsActive(tab),
      .index = window.IndexOf(tab),
      .window_id = window.GetWindowId(),
      .audible = tab.IsCurrentlyAudible(),
      .muted = tab.IsAudioMuted(),
      .status =
          std::string(tabs::ToString(ExtensionTabUtil::GetLoadingStatus(&tab))),
      .window_type = window.GetWindowTypeText(),
      .in_current_window = &window == &current,
      .in_last_focused_window = &window == &last_focused};
}

// Matches the privileged `title` and `url` filters. A tab the extension may
// not read matches neither, as in TabsQueryFunction::MatchesTab.
bool MatchesPrivileged(ExtensionFunction& function,
                       const tabs::Query::Params::QueryInfo& info,
                       const extensions::URLPatternSet& url_patterns,
                       content::WebContents& tab) {
  const ExtensionTabUtil::ScrubTabBehavior scrub =
      ExtensionTabUtil::GetScrubTabBehavior(
          function.extension(), function.source_context_type(), &tab);
  const bool may_read =
      scrub.committed_info != ExtensionTabUtil::kScrubTabFully;
  if (info.title && !info.title->empty() &&
      !(may_read &&
        base::MatchPattern(tab.GetTitle(), base::UTF8ToUTF16(*info.title)))) {
    return false;
  }
  if (url_patterns.is_empty()) {
    return true;
  }
  content::NavigationEntry* pending = tab.GetController().GetPendingEntry();
  return (may_read && url_patterns.MatchesURL(tab.GetLastCommittedURL())) ||
         (pending != nullptr &&
          scrub.pending_info != ExtensionTabUtil::kScrubTabFully &&
          url_patterns.MatchesURL(pending->GetVirtualURL()));
}

// Answers every function in RefusedOnDesk() with kNotOnADesk.
class DeskRefusalFunction : public ExtensionFunction {
 private:
  ~DeskRefusalFunction() override = default;

  ResponseAction Run() override { return RespondNow(Error(kNotOnADesk)); }
};

class DeskTabsQueryFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.query", TABS_QUERY)

 private:
  ~DeskTabsQueryFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::Query::Params> params =
        tabs::Query::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    const tabs::Query::Params::QueryInfo& info = params->query_info;

    // SCHEME_ALL, as in Chrome: matching grants no access.
    std::vector<std::string> patterns;
    if (info.url && info.url->as_string) {
      patterns.push_back(*info.url->as_string);
    } else if (info.url && info.url->as_strings) {
      patterns = *info.url->as_strings;
    }
    extensions::URLPatternSet url_patterns;
    std::string error;
    if (!url_patterns.Populate(patterns, URLPattern::SCHEME_ALL,
                               true, &error)) {
      return RespondNow(Error(std::move(error)));
    }

    const DeskTabQuery query = AsDeskTabQuery(info);
    base::ListValue result;
    DomicileWindowController* focused = LastFocusedDeskOf(*this);
    if (focused == nullptr) {
      return RespondNow(WithArguments(std::move(result)));
    }
    DomicileWindowController& current = *CurrentWindowOf(*this);
    DomicileWindowController& last_focused = focused->LastFocused();
    for (DomicileWindowController* desk : DesksOf(*this)) {
      for (DomicileWindowController* window : desk->Windows()) {
        for (int i = 0; i < window->GetTabCount(); ++i) {
          content::WebContents& tab = *window->GetWebContentsAt(i);
          if (DeskTabMatches(query,
                             FactsOf(*window, current, last_focused, tab)) &&
              MatchesPrivileged(*this, info, url_patterns, tab)) {
            result.Append(TabValue(*this, tab));
          }
        }
      }
    }
    return RespondNow(WithArguments(std::move(result)));
  }
};

class DeskTabsUpdateFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.update", TABS_UPDATE)

 private:
  ~DeskTabsUpdateFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::Update::Params> params =
        tabs::Update::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    const auto& update = params->update_properties;

    // Refuse unsupported properties first so no update is half applied.
    if (update.pinned.value_or(false) || update.opener_tab_id ||
        update.auto_discardable) {
      return RespondNow(Error(kNotOnADesk));
    }

    content::WebContents* tab = TabOrActive(*this, params->tab_id);
    if (tab == nullptr) {
      return RespondNow(Error(TabNotFound(params->tab_id)));
    }

    std::optional<GURL> url;
    if (update.url) {
      base::expected<GURL, std::string> prepared =
          ExtensionTabUtil::PrepareURLForNavigation(*update.url, extension(),
                                                    browser_context());
      if (!prepared.has_value()) {
        return RespondNow(Error(std::move(prepared.error())));
      }
      url = *prepared;
    }

    if (update.muted) {
      tab->SetAudioMuted(*update.muted);
    }
    if (url.has_value()) {
      GuestOf(*tab).Navigate(*url);
    }
    // The shell decides focus. The reply reflects the current state; the tab
    // becomes active once the shell focuses it.
    if (update.active.value_or(false) || update.highlighted.value_or(false) ||
        update.selected.value_or(false)) {
      GuestOf(*tab).RequestFocus();
    }
    return RespondNow(WithArguments(TabValue(*this, *tab)));
  }
};

class DeskTabsCreateFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.create", TABS_CREATE)

 private:
  ~DeskTabsCreateFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::Create::Params> params =
        tabs::Create::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    const auto& create = params->create_properties;

    // Placement, pinning, splitting and openers belong to the shell, and a
    // tab needs a URL to open as a browser window. It opens on the current
    // desk, or the one `windowId` names: private, from a private page.
    const bool current =
        !create.window_id || *create.window_id == kCurrentWindowId;
    DomicileWindowController* desk = current ? CurrentDeskOf(*this) : nullptr;
    for (DomicileWindowController* visible : DesksOf(*this)) {
      if (!current && *create.window_id == visible->GetWindowId()) {
        desk = visible;
      }
    }
    const bool on_desk = current || desk != nullptr;
    if (!on_desk || create.index || create.pinned.value_or(false) ||
        create.opener_tab_id || create.split_with_tab_id || !create.url) {
      return RespondNow(Error(kNotOnADesk));
    }

    base::expected<GURL, std::string> url =
        ExtensionTabUtil::PrepareURLForNavigation(*create.url, extension(),
                                                  browser_context());
    if (!url.has_value()) {
      return RespondNow(Error(std::move(url.error())));
    }

    // An extension's own page opens on the profile's desk, as Chrome opens a
    // spanning extension's pages in a normal window.
    if (url->SchemeIs(extensions::kExtensionScheme) && desk != nullptr &&
        desk != DeskOf(*this)) {
      desk = DeskOf(*this);
    }

    content::WebContents* asker =
        desk == nullptr ? nullptr : desk->GetActiveTab();
    if (asker == nullptr) {
      return RespondNow(Error(kNoWindowToAskError));
    }
    // The new tab is the next one the desk gains; this function is retained
    // until then. RequestWindow usually opens it synchronously, so this has
    // often already responded.
    desk->WhenNextTab(base::BindOnce(&DeskTabsCreateFunction::Created,
                                     base::WrapRefCounted(this)));
    GuestOf(*asker).RequestWindow(*url);
    return did_respond() ? AlreadyResponded() : RespondLater();
  }

  // Never null: the desk's own window is never closed.
  void Created(content::WebContents* tab) {
    CHECK(tab);
    Respond(WithArguments(TabValue(*this, *tab)));
  }
};

class DeskTabsRemoveFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.remove", TABS_REMOVE)

 private:
  ~DeskTabsRemoveFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::Remove::Params> params =
        tabs::Remove::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    std::vector<int> ids;
    if (params->tab_ids.as_integers) {
      ids = *params->tab_ids.as_integers;
    } else {
      EXTENSION_FUNCTION_VALIDATE(params->tab_ids.as_integer);
      ids.push_back(*params->tab_ids.as_integer);
    }

    // Resolve every id first so one bad id closes nothing.
    std::vector<content::WebContents*> found;
    for (int id : ids) {
      content::WebContents* tab = TabOrActive(*this, id);
      if (tab == nullptr) {
        return RespondNow(Error(extensions::ErrorUtils::FormatErrorMessage(
            kTabNotFoundError, base::NumberToString(id))));
      }
      found.push_back(tab);
    }
    // Not awaited: closing is asynchronous, and tabs.onRemoved reports it.
    for (content::WebContents* tab : found) {
      GuestOf(*tab).RequestClose();
    }
    return RespondNow(NoArguments());
  }
};

// The zoom functions act on the guest's per-site zoom in HostZoomMap, the same
// zoom the element's setZoom sets, so the element sees every change.
class DeskTabsSetZoomFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.setZoom", TABS_SETZOOM)

 private:
  ~DeskTabsSetZoomFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::SetZoom::Params> params =
        tabs::SetZoom::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    content::WebContents* tab = TabOrActive(*this, params->tab_id);
    if (tab == nullptr) {
      return RespondNow(Error(TabNotFound(params->tab_id)));
    }
    // As in Chrome, restricted pages cannot be zoomed.
    std::string error;
    if (extension()->permissions_data()->IsRestrictedUrl(
            tab->GetLastCommittedURL(), &error)) {
      return RespondNow(Error(std::move(error)));
    }
    const std::optional<double> factor = DeskZoomFactor(
        params->zoom_factor, DefaultZoomFactor(*tab),
        blink::kMinimumBrowserZoomFactor, blink::kMaximumBrowserZoomFactor);
    if (!factor.has_value()) {
      return RespondNow(Error(extensions::ErrorUtils::FormatErrorMessage(
          kZoomOutOfRangeError, base::NumberToString(params->zoom_factor))));
    }
    return RespondNow(GuestOf(*tab).ZoomTo(*factor)
                          ? NoArguments()
                          : Error(extensions::tabs_constants::
                                      kCannotZoomDisabledTabError));
  }
};

class DeskTabsGetZoomFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.getZoom", TABS_GETZOOM)

 private:
  ~DeskTabsGetZoomFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::GetZoom::Params> params =
        tabs::GetZoom::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    content::WebContents* tab = TabOrActive(*this, params->tab_id);
    if (tab == nullptr) {
      return RespondNow(Error(TabNotFound(params->tab_id)));
    }
    return RespondNow(ArgumentList(
        tabs::GetZoom::Results::Create(GuestOf(*tab).GetZoomFactor())));
  }
};

// Sets the guest's zoom mode, as Chrome's sets a tab's.
class DeskTabsSetZoomSettingsFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.setZoomSettings", TABS_SETZOOMSETTINGS)

 private:
  ~DeskTabsSetZoomSettingsFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::SetZoomSettings::Params> params =
        tabs::SetZoomSettings::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    content::WebContents* tab = TabOrActive(*this, params->tab_id);
    if (tab == nullptr) {
      return RespondNow(Error(TabNotFound(params->tab_id)));
    }
    std::string error;
    if (extension()->permissions_data()->IsRestrictedUrl(
            tab->GetLastCommittedURL(), &error)) {
      return RespondNow(Error(std::move(error)));
    }
    const tabs::ZoomSettings& settings = params->zoom_settings;
    if (!DeskTakesZoomSettings(tabs::ToString(settings.mode),
                               tabs::ToString(settings.scope))) {
      return RespondNow(Error(
          extensions::tabs_constants::kPerOriginOnlyInAutomaticError));
    }
    GuestOf(*tab).SetZoomMode(ZoomModeFor(settings));
    return RespondNow(NoArguments());
  }
};

class DeskTabsGetZoomSettingsFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("tabs.getZoomSettings", TABS_GETZOOMSETTINGS)

 private:
  ~DeskTabsGetZoomSettingsFunction() override = default;

  ResponseAction Run() override {
    std::optional<tabs::GetZoomSettings::Params> params =
        tabs::GetZoomSettings::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    content::WebContents* tab = TabOrActive(*this, params->tab_id);
    if (tab == nullptr) {
      return RespondNow(Error(TabNotFound(params->tab_id)));
    }
    tabs::ZoomSettings settings = DeskZoomSettings(*tab);
    settings.default_zoom_factor = DefaultZoomFactor(*tab);
    return RespondNow(
        ArgumentList(tabs::GetZoomSettings::Results::Create(settings)));
  }
};

// Base for the chrome.windows reads over the desk's window and its popups.
class DeskWindowReadFunction : public ExtensionFunction {
 protected:
  ~DeskWindowReadFunction() override = default;

  // Responds with `window`, or an error when it is null (no desk).
  ResponseAction RespondWithWindow(
      DomicileWindowController* window,
      const std::optional<windows::QueryOptions>& options) {
    if (window == nullptr) {
      return RespondNow(Error(ExtensionTabUtil::kNoCurrentWindowError));
    }
    return RespondNow(WithArguments(WindowValue(*window, options)));
  }

  base::DictValue WindowValue(
      DomicileWindowController& window,
      const std::optional<windows::QueryOptions>& options) {
    return window.CreateWindowValueForExtension(
        extension(),
        options && options->populate.value_or(false)
            ? extensions::WindowController::kPopulateTabs
            : extensions::WindowController::kDontPopulateTabs,
        source_context_type());
  }
};

class DeskWindowsGetFunction : public DeskWindowReadFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.get", WINDOWS_GET)

 private:
  ~DeskWindowsGetFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::Get::Params> params =
        windows::Get::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    DomicileWindowController* window = WindowNamed(*this, params->window_id);
    if (window == nullptr) {
      return RespondNow(Error(WindowNotFound(params->window_id)));
    }
    return RespondWithWindow(window, params->query_options);
  }
};

class DeskWindowsGetCurrentFunction : public DeskWindowReadFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.getCurrent", WINDOWS_GETCURRENT)

 private:
  ~DeskWindowsGetCurrentFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::GetCurrent::Params> params =
        windows::GetCurrent::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    return RespondWithWindow(CurrentWindowOf(*this), params->query_options);
  }
};

class DeskWindowsGetLastFocusedFunction : public DeskWindowReadFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.getLastFocused", WINDOWS_GETLASTFOCUSED)

 private:
  ~DeskWindowsGetLastFocusedFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::GetLastFocused::Params> params =
        windows::GetLastFocused::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    DomicileWindowController* desk = LastFocusedDeskOf(*this);
    return RespondWithWindow(desk == nullptr ? nullptr : &desk->LastFocused(),
                             params->query_options);
  }
};

class DeskWindowsGetAllFunction : public DeskWindowReadFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.getAll", WINDOWS_GETALL)

 private:
  ~DeskWindowsGetAllFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::GetAll::Params> params =
        windows::GetAll::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    // Filter by `windowTypes` as Chrome does; without it, return every
    // window.
    const std::optional<std::vector<windows::WindowType>>& types =
        params->query_options ? params->query_options->window_types
                              : std::nullopt;
    base::ListValue all;
    for (DomicileWindowController* desk : DesksOf(*this)) {
      for (DomicileWindowController* window : desk->Windows()) {
        if (!types.has_value() ||
            window->MatchesFilter(
                extensions::WindowController::GetFilterFromWindowTypes(
                    *types))) {
          all.Append(WindowValue(*window, params->query_options));
        }
      }
    }
    return RespondNow(WithArguments(std::move(all)));
  }
};

class DeskWindowsUpdateFunction : public DeskWindowReadFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.update", WINDOWS_UPDATE)

 private:
  ~DeskWindowsUpdateFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::Update::Params> params =
        windows::Update::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    const auto& update = params->update_info;

    // Bounds, state and attention belong to the shell; only focus can be
    // requested.
    if (update.left || update.top || update.width || update.height ||
        update.draw_attention || update.state != windows::WindowState::kNone ||
        !update.focused.value_or(true)) {
      return RespondNow(Error(kNotOnADesk));
    }
    DomicileWindowController* window = WindowNamed(*this, params->window_id);
    if (window == nullptr) {
      return RespondNow(Error(WindowNotFound(params->window_id)));
    }
    if (update.focused.value_or(false)) {
      content::WebContents* active = window->GetActiveTab();
      if (active == nullptr) {
        return RespondNow(Error(kNoWindowToAskError));
      }
      GuestOf(*active).RequestFocus();
    }
    return RespondNow(WithArguments(WindowValue(*window, std::nullopt)));
  }
};

// windows.create for a popup at one URL, which the shell draws.
// DeskOpensWindow in //components/domicile:desk_tabs decides what is refused.
//
// Creates the window with no tab, then asks the shell for a browser window as
// its tab. Responds once that tab attaches.
class DeskWindowsCreateFunction : public DeskWindowReadFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.create", WINDOWS_CREATE)

 private:
  ~DeskWindowsCreateFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::Create::Params> params =
        windows::Create::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    // No createData means a normal window at the new tab page.
    if (!params->create_data) {
      return RespondNow(Error(kNotOnADesk));
    }
    const windows::Create::Params::CreateData& create = *params->create_data;

    std::vector<std::string> urls;
    if (create.url && create.url->as_string) {
      urls.push_back(*create.url->as_string);
    } else if (create.url && create.url->as_strings) {
      urls = *create.url->as_strings;
    }
    const DeskWindowCreate asked{
        .type = create.type == windows::CreateType::kNone
                    ? std::string()
                    : std::string(windows::ToString(create.type)),
        .urls = static_cast<int>(urls.size()),
        .tab_id = create.tab_id.has_value(),
        .incognito = create.incognito.value_or(false),
        .state = create.state == windows::WindowState::kNone
                     ? std::string()
                     : std::string(windows::ToString(create.state)),
        .set_self_as_opener = create.set_self_as_opener.value_or(false)};
    if (!DeskOpensWindow(asked)) {
      return RespondNow(Error(kNotOnADesk));
    }

    base::expected<GURL, std::string> url =
        ExtensionTabUtil::PrepareURLForNavigation(urls.front(), extension(),
                                                  browser_context());
    if (!url.has_value()) {
      return RespondNow(Error(std::move(url.error())));
    }

    DomicileWindowController* desk = DeskOf(*this);
    content::WebContents* asker =
        desk == nullptr ? nullptr : desk->GetActiveTab();
    if (asker == nullptr) {
      return RespondNow(Error(kNoWindowToAskError));
    }
    DomicileWindowController& popup = desk->OpenPopup();
    // Retained until the window gets its tab or is removed. Usually responds
    // before RequestPopupWindow returns, as in tabs.create.
    popup.WhenNextTab(base::BindOnce(&DeskWindowsCreateFunction::Opened,
                                     base::WrapRefCounted(this),
                                     popup.GetWindowId()));
    GuestOf(*asker).RequestPopupWindow(popup.GetWindowId(), *url,
                                       create.width.value_or(0),
                                       create.height.value_or(0));
    return did_respond() ? AlreadyResponded() : RespondLater();
  }

  // Responds with the tabs populated, as Chrome's windows.create does.
  void Opened(int window_id, content::WebContents* tab) {
    if (tab == nullptr) {
      Respond(Error(WindowNotFound(window_id)));
      return;
    }
    DomicileWindowController* desk = DeskOf(*this);
    CHECK(desk);
    DomicileWindowController* popup = desk->WindowWithId(window_id);
    CHECK(popup);
    windows::QueryOptions populated;
    populated.populate = true;
    Respond(WithArguments(WindowValue(*popup, std::move(populated))));
  }
};

// windows.remove for a popup: closes its tab, which closes the window, or
// closes a tabless popup at once. The desk's own window cannot be removed.
class DeskWindowsRemoveFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("windows.remove", WINDOWS_REMOVE)

 private:
  ~DeskWindowsRemoveFunction() override = default;

  ResponseAction Run() override {
    std::optional<windows::Remove::Params> params =
        windows::Remove::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    DomicileWindowController* desk = DeskOf(*this);
    DomicileWindowController* window =
        desk == nullptr ? nullptr : desk->WindowWithId(params->window_id);
    if (window == nullptr) {
      return RespondNow(Error(WindowNotFound(params->window_id)));
    }
    if (!window->IsPopup()) {
      return RespondNow(Error(kNotOnADesk));
    }
    // Not awaited, as in tabs.remove: windows.onRemoved reports it.
    if (window->GetTabCount() == 0) {
      desk->ClosePopup(params->window_id);
    } else {
      for (int i = 0; i < window->GetTabCount(); ++i) {
        GuestOf(*window->GetWebContentsAt(i)).RequestClose();
      }
    }
    return RespondNow(NoArguments());
  }
};

// action.openPopup: the shell's tray opens the popup, since the desk has no
// toolbar. Answers once the shell is asked, not once the popup has loaded as
// Chrome's does: the request carries the popup's URL, so an extension that
// clears its popup after the call still gets the one it asked for.
class DeskActionOpenPopupFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("action.openPopup", ACTION_OPENPOPUP)

 private:
  ~DeskActionOpenPopupFunction() override = default;

  ResponseAction Run() override {
    // Validated as Chrome's is: the action API's types are not compiled.
    EXTENSION_FUNCTION_VALIDATE(args().size() == 1u);
    EXTENSION_FUNCTION_VALIDATE(extension());
    std::optional<int> window_id;
    if (args()[0].is_dict()) {
      const base::Value* value = args()[0].GetDict().Find("windowId");
      if (value != nullptr) {
        EXTENSION_FUNCTION_VALIDATE(value->is_int());
        window_id = value->GetInt();
      }
    }

    // The current window is the desk's, as Chrome's is the active browser
    // window rather than the caller's. A named one may be a private desk, for
    // an extension allowed there.
    DomicileWindowController* desk = DeskOf(*this);
    if (desk == nullptr) {
      return RespondNow(Error(kNoActiveWindowFound));
    }
    DomicileWindowController* window =
        !window_id.has_value() || *window_id == kCurrentWindowId
            ? desk
            : WindowNamed(*this, *window_id);
    if (window == nullptr) {
      return RespondNow(Error(WindowNotFound(*window_id)));
    }
    if (window->IsPopup()) {
      return RespondNow(Error(kNoToolbar));
    }

    extensions::ExtensionAction* action =
        extensions::ExtensionActionManager::Get(browser_context())
            ->GetExtensionAction(*extension());
    // The bindings expose `action` only to an extension that has one.
    CHECK(action);
    content::WebContents* tab = window->GetActiveTab();
    const int tab_id = tab == nullptr
                           ? extensions::ExtensionAction::kDefaultTabId
                           : sessions::SessionTabHelper::IdForTab(tab).id();
    if (!action->HasPopup(tab_id) ||
        !action->GetIsVisibleIgnoringDeclarative(tab_id)) {
      return RespondNow(Error(kNoActivePopup));
    }

    if (!RequestExtensionPopup(browser_context(), extension_id(),
                               action->GetPopupUrl(tab_id))) {
      return RespondNow(Error(kFailedToOpenPopup));
    }
    return RespondNow(NoArguments());
  }
};

// The extension's side panel page, as sidePanel.open and close find it: a
// tab's own panel, else the extension's global one, as Chrome picks. An
// invalid GURL when it has none, or turned it off.
GURL SidePanelOf(ExtensionFunction& function, std::optional<int> tab_id) {
  extensions::api::side_panel::PanelOptions options =
      extensions::SidePanelService::Get(function.browser_context())
          ->GetOptions(*function.extension(), tab_id);
  if (!options.path.has_value() || !options.enabled.value_or(false)) {
    return GURL();
  }
  return function.extension()->GetResourceURL(*options.path);
}

// The desk's popup window already showing side panel `panel`, or null. Matched
// on the page's address without its query or fragment, which a panel's own
// navigation changes.
DomicileWindowController* SidePanelWindow(DomicileWindowController& desk,
                                          const GURL& panel) {
  GURL::Replacements bare;
  bare.ClearQuery();
  bare.ClearRef();
  const GURL wanted = panel.ReplaceComponents(bare);
  for (DomicileWindowController* window : desk.Windows()) {
    content::WebContents* tab = window->GetActiveTab();
    if (window->IsPopup() && tab != nullptr &&
        tab->GetLastCommittedURL().ReplaceComponents(bare) == wanted) {
      return window;
    }
  }
  return nullptr;
}

// sidePanel.open and close's checks, shared: a target, the desk, the window
// named, and an enabled panel. Sets `panel`, or returns Chrome's error.
std::optional<std::string> SidePanelCheck(ExtensionFunction& function,
                                          std::optional<int> tab_id,
                                          std::optional<int> window_id,
                                          GURL& panel) {
  if (!tab_id.has_value() && !window_id.has_value()) {
    return "At least one of `tabId` and `windowId` must be provided";
  }
  if (DeskOf(function) == nullptr) {
    return kNoActiveWindowFound;
  }
  if (window_id.has_value() && WindowNamed(function, *window_id) == nullptr) {
    return WindowNotFound(*window_id);
  }
  panel = SidePanelOf(function, tab_id);
  if (!panel.is_valid()) {
    // In Chrome's words.
    return tab_id.has_value()
               ? base::StringPrintf("No active side panel for tabId: %d",
                                    *tab_id)
               : base::StringPrintf("No active side panel for windowId: %d",
                                    *window_id);
  }
  return std::nullopt;
}

// sidePanel.open: the desk has no side panel, so the panel opens as a popup
// window of its own with no size asked, which the shell tiles like any window,
// or the one already showing it is raised. A tile is taller than the 600 an
// action's popup may grow to, so an extension that checks its height (Phantom
// does) lays itself out as a side panel. Phantom opens in its side panel by default from 26.37, so a desk
// that refused this opened nothing.
//
// Unlike Chrome's, it asks for no user gesture: the desk's action clicks carry
// none.
class DeskSidePanelOpenFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("sidePanel.open", SIDEPANEL_OPEN)

 private:
  ~DeskSidePanelOpenFunction() override = default;

  ResponseAction Run() override {
    EXTENSION_FUNCTION_VALIDATE(extension());
    std::optional<extensions::api::side_panel::Open::Params> params =
        extensions::api::side_panel::Open::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    GURL panel;
    if (std::optional<std::string> error = SidePanelCheck(
            *this, params->options.tab_id, params->options.window_id, panel)) {
      return RespondNow(Error(std::move(*error)));
    }

    DomicileWindowController* desk = DeskOf(*this);
    if (DomicileWindowController* open = SidePanelWindow(*desk, panel)) {
      GuestOf(*open->GetActiveTab()).RequestFocus();
      return RespondNow(NoArguments());
    }
    content::WebContents* asker = desk->GetActiveTab();
    if (asker == nullptr) {
      return RespondNow(Error(kNoWindowToAskError));
    }
    DomicileWindowController& window = desk->OpenPopup();
    GuestOf(*asker).RequestPopupWindow(window.GetWindowId(), panel, 0, 0);
    return RespondNow(NoArguments());
  }
};

// sidePanel.close: closes the side panel's window, if one is open.
class DeskSidePanelCloseFunction : public ExtensionFunction {
 public:
  DECLARE_EXTENSION_FUNCTION("sidePanel.close", SIDEPANEL_CLOSE)

 private:
  ~DeskSidePanelCloseFunction() override = default;

  ResponseAction Run() override {
    EXTENSION_FUNCTION_VALIDATE(extension());
    std::optional<extensions::api::side_panel::Close::Params> params =
        extensions::api::side_panel::Close::Params::Create(args());
    EXTENSION_FUNCTION_VALIDATE(params);
    GURL panel;
    if (std::optional<std::string> error = SidePanelCheck(
            *this, params->options.tab_id, params->options.window_id, panel)) {
      return RespondNow(Error(std::move(*error)));
    }

    if (DomicileWindowController* open =
            SidePanelWindow(*DeskOf(*this), panel)) {
      GuestOf(*open->GetActiveTab()).RequestClose();
    }
    return RespondNow(NoArguments());
  }
};

}  // namespace

void RegisterDeskFunctions() {
  ExtensionFunctionRegistry& registry =
      ExtensionFunctionRegistry::GetInstance();
  registry.RegisterFunction<DeskTabsQueryFunction>();
  registry.RegisterFunction<DeskTabsUpdateFunction>();
  registry.RegisterFunction<DeskTabsCreateFunction>();
  registry.RegisterFunction<DeskTabsRemoveFunction>();
  registry.RegisterFunction<DeskTabsSetZoomFunction>();
  registry.RegisterFunction<DeskTabsGetZoomFunction>();
  registry.RegisterFunction<DeskTabsSetZoomSettingsFunction>();
  registry.RegisterFunction<DeskTabsGetZoomSettingsFunction>();
  registry.RegisterFunction<DeskWindowsGetFunction>();
  registry.RegisterFunction<DeskWindowsGetCurrentFunction>();
  registry.RegisterFunction<DeskWindowsGetLastFocusedFunction>();
  registry.RegisterFunction<DeskWindowsGetAllFunction>();
  registry.RegisterFunction<DeskWindowsUpdateFunction>();
  registry.RegisterFunction<DeskWindowsCreateFunction>();
  registry.RegisterFunction<DeskWindowsRemoveFunction>();
  registry.RegisterFunction<DeskActionOpenPopupFunction>();
  registry.RegisterFunction<DeskSidePanelOpenFunction>();
  registry.RegisterFunction<DeskSidePanelCloseFunction>();
  // Histogram UNKNOWN, so refusals are not counted as the refused calls.
  for (const char* name : RefusedOnDesk()) {
    registry.Register(ExtensionFunctionRegistry::FactoryEntry(
        &NewExtensionFunction<DeskRefusalFunction>, name,
        extensions::functions::UNKNOWN));
  }
}

}  // namespace domicile
