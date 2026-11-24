// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_window_controller.h"

#include <utility>

#include "base/check.h"
#include "base/check_op.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/ptr_util.h"
#include "base/memory/raw_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/values.h"
#include "chrome/browser/extensions/api/tabs/tabs_api.h"
#include "chrome/browser/extensions/api/tabs/tabs_constants.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/extensions/window_controller_list.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/extensions/api/tabs.h"
#include "chrome/common/extensions/api/windows.h"
#include "components/domicile/browser/desk_tabs.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "extensions/browser/event_router.h"
#include "extensions/browser/extension_event_histogram_value.h"
#include "extensions/common/constants.h"
#include "extensions/common/event_args.h"
#include "extensions/common/mojom/context_type.mojom.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/gfx/geometry/rect.h"
#include "url/gurl.h"

namespace domicile {
namespace {

using extensions::ExtensionTabUtil;

// The profile user data key for the desk.
constexpr char kDeskUserDataKey[] = "domicile_desk";

// chrome.tabs keys missing from tabs_constants. TabsEventRouter also defines
// them locally.
constexpr char kMutedInfoKey[] = "mutedInfo";
constexpr char kTabIdKey[] = "tabId";
// A windows event filter key, also local in WindowsEventRouter.
constexpr char kWindowTypesKey[] = "windowTypes";

std::vector<DomicileWindowController*>& Live() {
  static base::NoDestructor<std::vector<DomicileWindowController*>> live;
  return *live;
}

// How many times a desk's window has taken focus: a desk's `focused_at_` is
// this count when it last did.
uint64_t& FocusCount() {
  static uint64_t count = 0;
  return count;
}

// Looks up tab `tab_id` at dispatch time rather than send time: a lazy
// listener may wake after the tab is gone, and then the event is dropped.
//
// In every desk `context` may see: an extension allowed in private windows
// hears of a private tab with its own profile's context, unless it runs
// split. The EventRouter already kept the event from one not allowed.
content::WebContents* TabAtDispatch(content::BrowserContext* context,
                                    int tab_id) {
  for (DomicileWindowController* desk :
       DomicileWindowController::Visible(context, /*include_private=*/true)) {
    if (DomicileWindowController* window = desk->WindowWithTab(tab_id)) {
      return window->TabWithId(tab_id);
    }
  }
  return nullptr;
}

// Sets the windows.onCreated/onRemoved filter as WindowsEventRouter's
// WillDispatchWindowEvent does. WindowsEventRouter skips controllers with no
// Browser, so the desk dispatches these events itself.
bool WillDispatchWindowEvent(
    const std::string& window_type,
    content::BrowserContext* context,
    extensions::mojom::ContextType target_context,
    const extensions::Extension* extension,
    const base::DictValue* listener_filter,
    std::optional<base::ListValue>& event_args_out,
    extensions::mojom::EventFilteringInfoPtr& filtering,
    bool* dispatch_separate_event_out) {
  if (dispatch_separate_event_out != nullptr) {
    *dispatch_separate_event_out = false;
  }
  filtering = extensions::mojom::EventFilteringInfo::New();
  if (listener_filter != nullptr &&
      listener_filter->contains(kWindowTypesKey)) {
    filtering->window_type = window_type;
  } else {
    filtering->window_exposed_by_default = true;
  }
  return true;
}

// Builds tabs.onCreated's argument, scrubbed per listener as TabsEventRouter's
// WillDispatchTabCreatedEvent does. CreateTabObject gets `active` and `index`
// from the desk (domicile_desk_hooks.h).
bool WillDispatchCreated(int tab_id,
                         content::BrowserContext* context,
                         extensions::mojom::ContextType target_context,
                         const extensions::Extension* extension,
                         const base::DictValue* listener_filter,
                         std::optional<base::ListValue>& event_args_out,
                         extensions::mojom::EventFilteringInfoPtr& filtering,
                         bool* dispatch_separate_event_out) {
  content::WebContents* tab = TabAtDispatch(context, tab_id);
  if (tab == nullptr) {
    return false;
  }
  event_args_out.emplace();
  event_args_out->Append(
      ExtensionTabUtil::CreateTabObject(
          tab,
          ExtensionTabUtil::GetScrubTabBehavior(extension, target_context, tab),
          extension)
          .ToValue());
  return true;
}

// Builds tabs.onUpdated's arguments as WillDispatchTabUpdatedEvent does.
bool WillDispatchUpdated(int tab_id,
                         const std::set<std::string>& changed,
                         content::BrowserContext* context,
                         extensions::mojom::ContextType target_context,
                         const extensions::Extension* extension,
                         const base::DictValue* listener_filter,
                         std::optional<base::ListValue>& event_args_out,
                         extensions::mojom::EventFilteringInfoPtr& filtering,
                         bool* dispatch_separate_event_out) {
  content::WebContents* tab = TabAtDispatch(context, tab_id);
  if (tab == nullptr) {
    return false;
  }
  base::DictValue tab_value =
      ExtensionTabUtil::CreateTabObject(
          tab,
          ExtensionTabUtil::GetScrubTabBehavior(extension, target_context, tab),
          extension)
          .ToValue();
  base::DictValue changed_properties;
  for (const std::string& property : changed) {
    if (const base::Value* value = tab_value.Find(property)) {
      changed_properties.Set(property, value->Clone());
    }
  }
  event_args_out.emplace();
  event_args_out->Append(tab_id);
  event_args_out->Append(std::move(changed_properties));
  event_args_out->Append(std::move(tab_value));
  return true;
}

// Broadcasts `event` as TabsEventRouter::DispatchEvent does. A profile
// shutting down has no router.
void Broadcast(Profile* profile, std::unique_ptr<extensions::Event> event) {
  if (extensions::EventRouter* router = extensions::EventRouter::Get(profile)) {
    event->user_gesture =
        extensions::EventRouter::UserGestureState::kNotEnabled;
    router->BroadcastEvent(std::move(event));
  }
}

}  // namespace

// Observes one guest as a tab, like TabsEventRouter::TabEntry, plus focus and
// zoom from its element.
class DomicileWindowController::Tab : public content::WebContentsObserver {
 public:
  Tab(DomicileWindowController& window, content::WebContents& guest, int tab_id)
      : content::WebContentsObserver(&guest), window_(window), tab_id_(tab_id) {
    WebViewGuest* web_view = WebViewGuest::FromWebContents(&guest);
    CHECK(web_view);
    // Unretained is safe: the subscriptions are members.
    focused_ = web_view->AddFocusedCallback(
        base::BindRepeating(&Tab::OnFocused, base::Unretained(this)));
    zoomed_ = web_view->AddZoomChangedCallback(
        base::BindRepeating(&Tab::OnZoomed, base::Unretained(this)));
  }

  // content::WebContentsObserver:
  void NavigationEntryCommitted(
      const content::LoadCommittedDetails& load_details) override {
    complete_waiting_on_load_ = true;
    window_->Updated(tab_id_,
                     ChangedWithUrl(extensions::tabs_constants::kStatusKey));
  }

  // Only the first stop after a commit reports `complete`, as in TabEntry.
  void DidStopLoading() override {
    if (complete_waiting_on_load_) {
      complete_waiting_on_load_ = false;
      window_->Updated(tab_id_,
                       ChangedWithUrl(extensions::tabs_constants::kStatusKey));
    }
  }

  void TitleWasSet(content::NavigationEntry* entry) override {
    window_->Updated(tab_id_, {extensions::tabs_constants::kTitleKey});
  }

  void DidUpdateAudioMutingState(bool muted) override {
    window_->Updated(tab_id_, {kMutedInfoKey});
  }

  // Deletes this.
  void WebContentsDestroyed() override { window_->Removed(tab_id_); }

 private:
  void OnFocused() { window_->Focused(tab_id_, *web_contents()); }

  void OnZoomed(double old_factor, double new_factor) {
    window_->Zoomed(tab_id_, *web_contents(), old_factor, new_factor);
  }

  // Returns `property`, plus `url` if the URL changed since last reported.
  std::set<std::string> ChangedWithUrl(const char* property) {
    std::set<std::string> changed = {property};
    if (web_contents()->GetURL() != url_) {
      url_ = web_contents()->GetURL();
      changed.insert(extensions::tabs_constants::kUrlKey);
    }
    return changed;
  }

  const raw_ref<DomicileWindowController> window_;
  const int tab_id_;
  GURL url_;
  bool complete_waiting_on_load_ = false;
  base::CallbackListSubscription focused_;
  base::CallbackListSubscription zoomed_;
};

extensions::api::tabs::ZoomSettings DeskZoomSettings(
    content::WebContents& tab) {
  WebViewGuest* guest = WebViewGuest::FromWebContents(&tab);
  CHECK(guest);
  extensions::api::tabs::ZoomSettings settings;
  extensions::ZoomModeToZoomSettings(guest->GetZoomMode(), &settings);
  return settings;
}

// static
DomicileWindowController& DomicileWindowController::For(Profile* profile) {
  if (DomicileWindowController* desk = Find(profile)) {
    return *desk;
  }
  auto made = std::make_unique<DomicileWindowController>(profile);
  DomicileWindowController& desk = *made;
  if (profile->IsOffTheRecord()) {
    desk.private_profile_.Observe(profile);
  }
  profile->SetUserData(kDeskUserDataKey, std::move(made));
  return desk;
}

void DomicileWindowController::OnProfileWillBeDestroyed(Profile* profile) {
  private_profile_.Reset();
  // Deletes this.
  profile->RemoveUserData(kDeskUserDataKey);
}

// static
DomicileWindowController* DomicileWindowController::Find(
    content::BrowserContext* context) {
  return context == nullptr ? nullptr
                            : static_cast<DomicileWindowController*>(
                                  context->GetUserData(kDeskUserDataKey));
}

// static
std::vector<DomicileWindowController*> DomicileWindowController::All() {
  return Live();
}

// static
std::vector<DomicileWindowController*> DomicileWindowController::Visible(
    content::BrowserContext* context,
    bool include_private) {
  std::vector<DomicileWindowController*> desks;
  if (DomicileWindowController* own = Find(context)) {
    desks.push_back(own);
  }
  Profile* profile =
      context == nullptr ? nullptr : Profile::FromBrowserContext(context);
  if (include_private && profile != nullptr && !profile->IsOffTheRecord()) {
    if (DomicileWindowController* in_private =
            Find(profile->GetPrimaryOTRProfile(/*create_if_needed=*/false))) {
      desks.push_back(in_private);
    }
  }
  return desks;
}

// static
DomicileWindowController* DomicileWindowController::LastFocusedDesk(
    content::BrowserContext* context,
    bool include_private) {
  // A private desk whose tabs all closed is gone, as a closed incognito
  // window is.
  DomicileWindowController* last = nullptr;
  for (DomicileWindowController* desk : Visible(context, include_private)) {
    const bool open = desk == Find(context) || desk->GetTabCount() > 0;
    if (open && (last == nullptr || desk->focused_at_ > last->focused_at_)) {
      last = desk;
    }
  }
  return last;
}

DomicileWindowController::DomicileWindowController(Profile* profile)
    : extensions::WindowController(&window_, profile),
      session_id_(SessionID::NewUnique()),
      desk_(nullptr),
      last_focused_(session_id_.id()) {
  Live().push_back(this);
  extensions::WindowControllerList::GetInstance()->AddExtensionWindow(this);
}

DomicileWindowController::DomicileWindowController(
    Profile* profile,
    DomicileWindowController& desk)
    : extensions::WindowController(&window_, profile),
      session_id_(SessionID::NewUnique()),
      desk_(&desk) {
  Live().push_back(this);
  extensions::WindowControllerList::GetInstance()->AddExtensionWindow(this);
}

DomicileWindowController::~DomicileWindowController() {
  extensions::WindowControllerList::GetInstance()->RemoveExtensionWindow(this);
  std::erase(Live(), this);
}

void DomicileWindowController::Add(content::WebContents& guest) {
  const int tab_id = ExtensionTabUtil::GetTabId(&guest);
  CHECK(SessionID::IsValidValue(tab_id));
  // Sets the `windowId` that tab objects and events report.
  sessions::SessionTabHelper::FromWebContents(&guest)->SetWindowID(session_id_);

  const std::optional<int> before = tabs_.Active();
  VLOG(1) << "domicile: tab " << tab_id << " joins extension window "
          << GetWindowId() << (IsPopup() ? " (a popup)" : "");
  tabs_.Add(tab_id);
  by_id_.emplace(tab_id, std::make_unique<Tab>(*this, guest, tab_id));

  auto event = std::make_unique<extensions::Event>(
      extensions::events::TABS_ON_CREATED,
      extensions::api::tabs::OnCreated::kEventName, nullptr, profile());
  event->will_dispatch_callback =
      base::BindRepeating(&WillDispatchCreated, tab_id);
  Broadcast(profile(), std::move(event));

  ActiveMaybeChanged(before);

  if (!waiting_for_tab_.empty()) {
    base::OnceCallback<void(content::WebContents*)> gained =
        std::move(waiting_for_tab_.front());
    waiting_for_tab_.pop_front();
    std::move(gained).Run(&guest);
  }
}

void DomicileWindowController::WhenNextTab(
    base::OnceCallback<void(content::WebContents*)> gained) {
  waiting_for_tab_.push_back(std::move(gained));
}

DomicileWindowController& DomicileWindowController::OpenPopup() {
  CHECK(!IsPopup());
  std::unique_ptr<DomicileWindowController> made =
      base::WrapUnique(new DomicileWindowController(profile(), *this));
  DomicileWindowController& popup = *made;
  VLOG(1) << "domicile: extension popup window " << popup.GetWindowId()
          << " opens over window " << GetWindowId();
  popups_.emplace(popup.GetWindowId(), std::move(made));
  BroadcastWindowEvent(popup, /*created=*/true);
  return popup;
}

DomicileWindowController* DomicileWindowController::PopupAwaitingTab(
    int window_id) const {
  CHECK(!IsPopup());
  const auto found = popups_.find(window_id);
  return found == popups_.end() || found->second->GetTabCount() > 0
             ? nullptr
             : found->second.get();
}

void DomicileWindowController::ClosePopup(int window_id) {
  CHECK(!IsPopup());
  const auto found = popups_.find(window_id);
  CHECK(found != popups_.end());
  CHECK_EQ(found->second->GetTabCount(), 0);
  std::unique_ptr<DomicileWindowController> popup = std::move(found->second);
  popups_.erase(found);
  VLOG(1) << "domicile: extension popup window " << window_id << " closes";
  if (last_focused_ == window_id) {
    last_focused_ = GetWindowId();
  }
  BroadcastWindowEvent(*popup, /*created=*/false);
  // Tell windows.create callers that the tab will never arrive.
  while (!popup->waiting_for_tab_.empty()) {
    base::OnceCallback<void(content::WebContents*)> gained =
        std::move(popup->waiting_for_tab_.front());
    popup->waiting_for_tab_.pop_front();
    std::move(gained).Run(nullptr);
  }
}

std::vector<DomicileWindowController*> DomicileWindowController::Windows()
    const {
  CHECK(!IsPopup());
  std::vector<DomicileWindowController*> windows = {
      const_cast<DomicileWindowController*>(this)};
  for (const auto& [window_id, popup] : popups_) {
    windows.push_back(popup.get());
  }
  return windows;
}

DomicileWindowController* DomicileWindowController::WindowWithId(
    int window_id) const {
  for (DomicileWindowController* window : Windows()) {
    if (window->GetWindowId() == window_id) {
      return window;
    }
  }
  return nullptr;
}

DomicileWindowController* DomicileWindowController::WindowWithTab(
    int tab_id) const {
  for (DomicileWindowController* window : Windows()) {
    if (window->TabWithId(tab_id) != nullptr) {
      return window;
    }
  }
  return nullptr;
}

DomicileWindowController* DomicileWindowController::WindowOf(
    content::WebContents& contents) const {
  for (DomicileWindowController* window : Windows()) {
    if (window->Contains(contents)) {
      return window;
    }
  }
  return nullptr;
}

DomicileWindowController& DomicileWindowController::LastFocused() const {
  DomicileWindowController* window = WindowWithId(last_focused_);
  CHECK(window);
  return *window;
}

void DomicileWindowController::PopupFocused(int window_id) {
  CHECK(!IsPopup());
  last_focused_ = window_id;
  TookFocus();
}

void DomicileWindowController::TookFocus() {
  CHECK(!IsPopup());
  const bool was_last = focused_at_ == FocusCount();
  focused_at_ = ++FocusCount();
  VLOG(1) << "domicile: extension window " << GetWindowId()
          << " took focus, last focused " << last_focused_;
  // From another desk: a profile's desk and its private profile's take turns
  // as the active tab's.
  if (!was_last) {
    NotifyActiveTabChanged();
  }
}

void DomicileWindowController::NotifyActiveTabChanged() {
  for (DeskObserver& observer : observers_) {
    observer.OnActiveTabChanged();
  }
  // The shell's tray observes the profile's desk, not its private profile's.
  if (profile()->IsOffTheRecord()) {
    if (DomicileWindowController* original =
            Find(profile()->GetOriginalProfile())) {
      for (DeskObserver& observer : original->observers_) {
        observer.OnActiveTabChanged();
      }
    }
  }
}

// Called last in the popup's Removed, because it deletes the popup.
void DomicileWindowController::PopupEmptied(int window_id) {
  ClosePopup(window_id);
}

void DomicileWindowController::BroadcastWindowEvent(
    DomicileWindowController& window,
    bool created) {
  auto args = base::MakeRefCounted<extensions::EventArgs>();
  // Unpopulated, as WindowsEventRouter sends it, so no per-listener
  // scrubbing is needed.
  if (created) {
    args->data.Append(window.CreateWindowValueForExtension(
        nullptr, kDontPopulateTabs,
        extensions::mojom::ContextType::kUnspecified));
  } else {
    args->data.Append(window.GetWindowId());
  }
  auto event = std::make_unique<extensions::Event>(
      created ? extensions::events::WINDOWS_ON_CREATED
              : extensions::events::WINDOWS_ON_REMOVED,
      created ? extensions::api::windows::OnCreated::kEventName
              : extensions::api::windows::OnRemoved::kEventName,
      std::move(args), profile());
  event->will_dispatch_callback =
      base::BindRepeating(&WillDispatchWindowEvent, window.GetWindowTypeText());
  Broadcast(profile(), std::move(event));
}

content::WebContents* DomicileWindowController::TabWithId(int tab_id) const {
  const auto found = by_id_.find(tab_id);
  return found == by_id_.end() ? nullptr : found->second->web_contents();
}

bool DomicileWindowController::Contains(content::WebContents& contents) const {
  return TabWithId(ExtensionTabUtil::GetTabId(&contents)) == &contents;
}

int DomicileWindowController::IndexOf(content::WebContents& tab) const {
  return tabs_.IndexOf(ExtensionTabUtil::GetTabId(&tab));
}

bool DomicileWindowController::IsActive(content::WebContents& tab) const {
  return tabs_.Active() == ExtensionTabUtil::GetTabId(&tab);
}

void DomicileWindowController::AddObserver(DeskObserver* observer) {
  observers_.AddObserver(observer);
}

void DomicileWindowController::RemoveObserver(DeskObserver* observer) {
  observers_.RemoveObserver(observer);
}

int DomicileWindowController::GetWindowId() const {
  return session_id_.id();
}

std::string DomicileWindowController::GetWindowTypeText() const {
  return extensions::api::tabs::ToString(
      IsPopup() ? extensions::api::tabs::WindowType::kPopup
                : extensions::api::tabs::WindowType::kNormal);
}

// The shell owns the desk's size, which already fills the screen.
void DomicileWindowController::SetFullscreenMode(
    bool is_fullscreen,
    const GURL& extension_url) const {}

content::WebContents* DomicileWindowController::GetActiveTab() const {
  const std::optional<int> active = tabs_.Active();
  return active.has_value() ? TabWithId(*active) : nullptr;
}

int DomicileWindowController::GetTabCount() const {
  return static_cast<int>(tabs_.InCreationOrder().size());
}

content::WebContents* DomicileWindowController::GetWebContentsAt(int i) const {
  const std::vector<int>& order = tabs_.InCreationOrder();
  return i < 0 || static_cast<size_t>(i) >= order.size()
             ? nullptr
             : TabWithId(order[static_cast<size_t>(i)]);
}

bool DomicileWindowController::IsVisibleToTabsAPIForExtension(
    const extensions::Extension* extension,
    bool include_dev_tools_windows) const {
  return true;
}

base::DictValue DomicileWindowController::CreateWindowValueForExtension(
    const extensions::Extension* extension,
    PopulateTabBehavior populate_tab_behavior,
    extensions::mojom::ContextType context) const {
  // Like BrowserExtensionWindowController, minus the size, which only the
  // shell knows. The schema makes it optional.
  base::DictValue window;
  window.Set(extension_misc::kId, GetWindowId());
  window.Set("type", GetWindowTypeText());
  // Focused if its desk's window last took focus, and that desk did of the
  // profile's and its private profile's.
  const DomicileWindowController& desk = IsPopup() ? *desk_ : *this;
  window.Set("focused", desk.last_focused_ == GetWindowId() &&
                            LastFocusedDesk(profile()->GetOriginalProfile(),
                                            /*include_private=*/true) == &desk);
  // Report the desk's origin. Extensions such as Bitwarden position popups
  // from `left` and `top` and pass NaN to windows.create without them. On
  // Linux, 0,0 also signals that window positions are unreliable.
  if (!IsPopup()) {
    window.Set("left", 0);
    window.Set("top", 0);
  }
  window.Set("incognito", profile()->IsOffTheRecord());
  window.Set("alwaysOnTop", false);
  window.Set("state", "normal");
  if (populate_tab_behavior == kPopulateTabs) {
    window.Set(ExtensionTabUtil::kTabsKey, CreateTabList(extension, context));
  }
  return window;
}

base::ListValue DomicileWindowController::CreateTabList(
    const extensions::Extension* extension,
    extensions::mojom::ContextType context) const {
  base::ListValue list;
  for (int tab_id : tabs_.InCreationOrder()) {
    content::WebContents* tab = TabWithId(tab_id);
    list.Append(
        ExtensionTabUtil::CreateTabObject(
            tab, ExtensionTabUtil::GetScrubTabBehavior(extension, context, tab),
            extension)
            .ToValue());
  }
  return list;
}

// Asks the shell, through the active tab's element, to open the options page
// as a new window, as `target="_blank"` does. Returns false with no active
// tab.
bool DomicileWindowController::OpenOptionsPage(
    const extensions::Extension* extension,
    const GURL& url,
    bool open_in_tab) {
  // A popup's tab is an extension page, so ask through the desk's window.
  if (IsPopup()) {
    return desk_->OpenOptionsPage(extension, url, open_in_tab);
  }
  content::WebContents* active = GetActiveTab();
  if (active == nullptr) {
    return false;
  }
  WebViewGuest::FromWebContents(active)->RequestWindow(url);
  return true;
}

// A focused popup tab only updates the desk's last-focused window. A desk tab
// becomes active per DeskTabs' rule, which also makes the desk last focused.
void DomicileWindowController::Focused(int tab_id, content::WebContents& tab) {
  if (IsPopup()) {
    desk_->PopupFocused(GetWindowId());
  } else if (TakesActiveOnFocus(tab.GetLastCommittedURL().scheme())) {
    const std::optional<int> before = tabs_.Active();
    tabs_.Focus(tab_id);
    last_focused_ = GetWindowId();
    TookFocus();
    ActiveMaybeChanged(before);
  }
}

void DomicileWindowController::Updated(int tab_id,
                                       std::set<std::string> changed) {
  auto event = std::make_unique<extensions::Event>(
      extensions::events::TABS_ON_UPDATED,
      extensions::api::tabs::OnUpdated::kEventName, nullptr, profile());
  event->will_dispatch_callback =
      base::BindRepeating(&WillDispatchUpdated, tab_id, std::move(changed));
  Broadcast(profile(), std::move(event));
}

// Fires tabs.onZoomChange as TabsEventRouter::OnZoomChanged does, without a
// default factor in the settings.
void DomicileWindowController::Zoomed(int tab_id,
                                      content::WebContents& tab,
                                      double old_factor,
                                      double new_factor) {
  extensions::api::tabs::OnZoomChange::ZoomChangeInfo info;
  info.tab_id = tab_id;
  info.old_zoom_factor = old_factor;
  info.new_zoom_factor = new_factor;
  info.zoom_settings = DeskZoomSettings(tab);
  Broadcast(profile(),
            std::make_unique<extensions::Event>(
                extensions::events::TABS_ON_ZOOM_CHANGE,
                extensions::api::tabs::OnZoomChange::kEventName,
                base::MakeRefCounted<extensions::EventArgs>(
                    extensions::api::tabs::OnZoomChange::Create(info)),
                profile()));
}

void DomicileWindowController::Removed(int tab_id) {
  const std::optional<int> before = tabs_.Active();
  tabs_.Remove(tab_id);
  by_id_.erase(tab_id);

  base::DictValue info;
  info.Set(extensions::tabs_constants::kWindowIdKey, GetWindowId());
  // A popup closes with its tab; the desk's window never closes.
  info.Set(extensions::tabs_constants::kIsWindowClosingKey,
           IsPopup() && GetTabCount() == 0);
  auto args = base::MakeRefCounted<extensions::EventArgs>();
  args->data.Append(tab_id);
  args->data.Append(std::move(info));
  Broadcast(profile(), std::make_unique<extensions::Event>(
                           extensions::events::TABS_ON_REMOVED,
                           extensions::api::tabs::OnRemoved::kEventName,
                           std::move(args), profile()));

  ActiveMaybeChanged(before);

  // Must be last: it deletes this.
  if (IsPopup() && GetTabCount() == 0) {
    desk_->PopupEmptied(GetWindowId());
  }
}

void DomicileWindowController::ActiveMaybeChanged(std::optional<int> before) {
  const std::optional<int> after = tabs_.Active();
  if (after == before) {
    return;
  }
  if (after.has_value()) {
    base::DictValue info;
    info.Set(kTabIdKey, *after);
    info.Set(extensions::tabs_constants::kWindowIdKey, GetWindowId());
    auto args = base::MakeRefCounted<extensions::EventArgs>();
    args->data.Append(std::move(info));
    Broadcast(profile(), std::make_unique<extensions::Event>(
                             extensions::events::TABS_ON_ACTIVATED,
                             extensions::api::tabs::OnActivated::kEventName,
                             std::move(args), profile()));
  }
  NotifyActiveTabChanged();
}

bool DeskWindow::IsActive() const {
  return true;
}
bool DeskWindow::IsMaximized() const {
  return false;
}
bool DeskWindow::IsMinimized() const {
  return false;
}
bool DeskWindow::IsFullscreen() const {
  return false;
}
gfx::NativeWindow DeskWindow::GetNativeWindow() const {
  return gfx::NativeWindow();
}
gfx::Rect DeskWindow::GetRestoredBounds() const {
  return gfx::Rect();
}
ui::mojom::WindowShowState DeskWindow::GetRestoredState() const {
  return ui::mojom::WindowShowState::kNormal;
}
gfx::Rect DeskWindow::GetBounds() const {
  return gfx::Rect();
}
void DeskWindow::Show() {}
void DeskWindow::Hide() {}
bool DeskWindow::IsVisible() const {
  return true;
}
void DeskWindow::ShowInactive() {}
void DeskWindow::Close() {}
void DeskWindow::Activate() {}
void DeskWindow::Deactivate() {}
void DeskWindow::Maximize() {}
void DeskWindow::Minimize() {}
void DeskWindow::Restore() {}
void DeskWindow::SetBounds(const gfx::Rect& bounds) {}
void DeskWindow::FlashFrame(bool flash) {}
ui::ZOrderLevel DeskWindow::GetZOrderLevel() const {
  return ui::ZOrderLevel::kNormal;
}
void DeskWindow::SetZOrderLevel(ui::ZOrderLevel order) {}

}  // namespace domicile
