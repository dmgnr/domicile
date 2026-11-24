// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_WINDOW_CONTROLLER_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_WINDOW_CONTROLLER_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "base/containers/circular_deque.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/observer_list.h"
#include "base/scoped_observation.h"
#include "base/supports_user_data.h"
#include "chrome/browser/domicile/domicile_desk.h"
#include "chrome/browser/extensions/window_controller.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/common/extensions/api/tabs.h"
#include "components/domicile/browser/desk_tabs.h"
#include "components/sessions/core/session_id.h"
#include "ui/base/base_window.h"

class GURL;
class Profile;

namespace content {
class BrowserContext;
class WebContents;
}  // namespace content

namespace domicile {

// The ui::BaseWindow a WindowController requires, for a window the shell
// draws.
//
// Reports itself active, visible and normal; every command is a no-op. The
// desk replaces the chrome.windows functions that would issue commands
// (domicile_desk_functions.h).
class DeskWindow final : public ui::BaseWindow {
 public:
  // ui::BaseWindow:
  bool IsActive() const override;
  bool IsMaximized() const override;
  bool IsMinimized() const override;
  bool IsFullscreen() const override;
  gfx::NativeWindow GetNativeWindow() const override;
  gfx::Rect GetRestoredBounds() const override;
  ui::mojom::WindowShowState GetRestoredState() const override;
  gfx::Rect GetBounds() const override;
  void Show() override;
  void Hide() override;
  bool IsVisible() const override;
  void ShowInactive() override;
  void Close() override;
  void Activate() override;
  void Deactivate() override;
  void Maximize() override;
  void Minimize() override;
  void Restore() override;
  void SetBounds(const gfx::Rect& bounds) override;
  void FlashFrame(bool flash) override;
  ui::ZOrderLevel GetZOrderLevel() const override;
  void SetZOrderLevel(ui::ZOrderLevel order) override;
};

// A desk tab's zoom settings: its guest's zoom mode, as Chrome reports a tab's.
extensions::api::tabs::ZoomSettings DeskZoomSettings(
    content::WebContents& tab);

// A chrome.windows window of a profile's desk. See domicile_desk.h.
//
// - The desk's own window: type `normal`, tabs are the profile's <webview>s.
//   Owned by the profile as user data, so it outlives every guest in it.
// - A windows.create popup: type `popup`, owned by the desk's window, with one
//   browser-window tab. Closed when that tab goes, or by windows.remove before
//   it has one.
//
// A private profile's desk goes on OnProfileWillBeDestroyed, not with the
// user data: removing a window tells the original profile's
// WindowsEventRouter, which asks the window's profile, and an
// off-the-record profile clears its user data only once half destroyed.
class DomicileWindowController final : public extensions::WindowController,
                                       public base::SupportsUserData::Data,
                                       public ProfileObserver {
 public:
  // `profile`'s desk, created on first use.
  static DomicileWindowController& For(Profile* profile);

  // `context`'s desk, or null if none exists.
  static DomicileWindowController* Find(content::BrowserContext* context);

  // Every desk and popup window, for ForEachTab.
  static std::vector<DomicileWindowController*> All();

  // The desks an extension calling from `context` sees: `context`'s, then,
  // with `include_private`, its private profile's, as Chrome shows incognito
  // windows to an extension allowed in them. `include_private` is
  // ExtensionFunction::include_incognito_information(), or
  // util::IsIncognitoEnabled. Empty with no desk.
  static std::vector<DomicileWindowController*> Visible(
      content::BrowserContext* context,
      bool include_private);

  // Of Visible(), the desk whose tab last took focus, as Chrome's current
  // window is the last active browser; `context`'s desk before any has. Null
  // with no desk.
  static DomicileWindowController* LastFocusedDesk(
      content::BrowserContext* context,
      bool include_private);

  // A desk's own window.
  explicit DomicileWindowController(Profile* profile);
  DomicileWindowController(const DomicileWindowController&) = delete;
  DomicileWindowController& operator=(const DomicileWindowController&) = delete;
  ~DomicileWindowController() override;

  // Adds `guest` as a tab and fires chrome.tabs.onCreated, plus onActivated
  // for the first tab.
  void Add(content::WebContents& guest);

  // The members down to IsPopup() are for the desk's own window only.
  //
  // Creates a popup window with no tab and fires chrome.windows.onCreated.
  // The caller opens a browser window as its tab.
  DomicileWindowController& OpenPopup();

  // The popup window `window_id` if it is still waiting for its tab, or null.
  DomicileWindowController* PopupAwaitingTab(int window_id) const;

  // Closes the tabless popup window `window_id`, fires
  // chrome.windows.onRemoved, and runs its WhenNextTab callbacks with null.
  void ClosePopup(int window_id);

  // This window and its popups, in creation order.
  std::vector<DomicileWindowController*> Windows() const;

  // The window in Windows() with `window_id`, or null.
  DomicileWindowController* WindowWithId(int window_id) const;

  // The window holding tab `tab_id`, or null.
  DomicileWindowController* WindowWithTab(int tab_id) const;

  // The window holding `contents`, or null.
  DomicileWindowController* WindowOf(content::WebContents& contents) const;

  // chrome.windows.getLastFocused: the window whose tab last took focus, or
  // this one if none has.
  DomicileWindowController& LastFocused() const;

  // Whether this is a popup window rather than a desk's own.
  bool IsPopup() const { return desk_ != nullptr; }

  // The tab `tab_id` in this window, or null.
  content::WebContents* TabWithId(int tab_id) const;

  // Whether `contents` is a tab of this window.
  bool Contains(content::WebContents& contents) const;

  // `tab`'s index and whether it is active. `tab` must be in this window.
  int IndexOf(content::WebContents& tab) const;
  bool IsActive(content::WebContents& tab) const;

  // Runs `gained` once with the next tab this window gains, in request order.
  // tabs.create and windows.create use it because the shell creates the tab.
  // Runs with null if a popup closes before getting a tab.
  void WhenNextTab(base::OnceCallback<void(content::WebContents*)> gained);

  void AddObserver(DeskObserver* observer);
  void RemoveObserver(DeskObserver* observer);

  // extensions::WindowController:
  int GetWindowId() const override;
  std::string GetWindowTypeText() const override;
  void SetFullscreenMode(bool is_fullscreen,
                         const GURL& extension_url) const override;
  content::WebContents* GetActiveTab() const override;
  int GetTabCount() const override;
  content::WebContents* GetWebContentsAt(int i) const override;
  bool IsVisibleToTabsAPIForExtension(
      const extensions::Extension* extension,
      bool include_dev_tools_windows) const override;
  base::DictValue CreateWindowValueForExtension(
      const extensions::Extension* extension,
      PopulateTabBehavior populate_tab_behavior,
      extensions::mojom::ContextType context) const override;
  base::ListValue CreateTabList(
      const extensions::Extension* extension,
      extensions::mojom::ContextType context) const override;
  bool OpenOptionsPage(const extensions::Extension* extension,
                       const GURL& url,
                       bool open_in_tab) override;

 private:
  class Tab;

  // A popup window of `desk`.
  DomicileWindowController(Profile* profile, DomicileWindowController& desk);

  // ProfileObserver, for a private profile's desk: deletes it.
  void OnProfileWillBeDestroyed(Profile* profile) override;

  // Popup-to-desk notifications: its tab took focus, or its tab closed.
  // PopupEmptied deletes the popup.
  void PopupFocused(int window_id);
  void PopupEmptied(int window_id);

  // Desk window only: one of its windows took focus. Notifies observers when
  // another desk had it.
  void TookFocus();

  // Tells observers, and for a private profile's desk the profile's desk's
  // observers, that the active tab may have changed.
  void NotifyActiveTabChanged();

  // Fires windows.onCreated or onRemoved for `window`.
  void BroadcastWindowEvent(DomicileWindowController& window, bool created);

  // Notifications from each tab's guest.
  void Focused(int tab_id, content::WebContents& tab);
  void Updated(int tab_id, std::set<std::string> changed);
  void Zoomed(int tab_id,
              content::WebContents& tab,
              double old_factor,
              double new_factor);
  // Deletes the Tab calling it.
  void Removed(int tab_id);

  // Fires onActivated and notifies observers if the active tab changed from
  // `before`.
  void ActiveMaybeChanged(std::optional<int> before);

  DeskWindow window_;
  const SessionID session_id_;
  // The desk's window, for a popup; null for the desk's own.
  const raw_ptr<DomicileWindowController> desk_;
  DeskTabs tabs_;
  std::map<int, std::unique_ptr<Tab>> by_id_;
  base::circular_deque<base::OnceCallback<void(content::WebContents*)>>
      waiting_for_tab_;
  base::ObserverList<DeskObserver> observers_;

  // Desk window only: popups by id (map order is creation order, since
  // SessionIDs increase) and the last focused window.
  std::map<int, std::unique_ptr<DomicileWindowController>> popups_;
  int last_focused_ = -1;
  // When one of this desk's windows last took focus, in a count shared by
  // every desk; 0 before any has. Orders a profile's desk and its private
  // profile's for LastFocusedDesk.
  uint64_t focused_at_ = 0;
  // A private profile's desk only: its profile, until it is destroyed.
  base::ScopedObservation<Profile, ProfileObserver> private_profile_{this};
};

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_WINDOW_CONTROLLER_H_
