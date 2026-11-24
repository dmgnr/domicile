// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_BROWSER_WINDOWS_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_BROWSER_WINDOWS_H_

#include <optional>
#include <string>
#include <vector>

#include "base/callback_list.h"
#include "base/functional/callback.h"
#include "components/domicile/browser/desk_pointer.h"
#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/web_view_partition.h"
#include "components/domicile/mojom/browser_windows.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "ui/gfx/geometry/point_f.h"

class GURL;

namespace content {
class RenderFrameHost;
class WebContents;
}  // namespace content

namespace domicile {

class ElectronPage;

// The desk's browser windows, one list per profile. The profile owns each
// window's page, so `domicile load-shell` keeps them. See
// components/domicile/mojom/browser_windows.mojom.
//
// - Window: a WebViewGuest from WebViewGuest::MakeWindow, owned by the
//   shell's WebContents, and a tab of the desk.
// - Shown: by a <webview window="id">, which attaches the page. Content
//   detaches it when the element's frame goes.
// - Opened by: `domicile open-url`, a page's new window, an extension's
//   tabs.create or windows.create, or the shell (mojom::BrowserWindows.Open
//   and OpenApp).
// - Closed by: its page's window.close(), an extension's tabs.remove, or the
//   shell (mojom::BrowserWindows.Close).
//
// Every open and close sends the whole list to every shell document of the
// profile. A reloaded shell learns its windows this way.

// Installs WebViewGuest's BrowserWindowHost and the finder a capture of one
// browser window uses (components/domicile/browser/
// browser_window_capture_target.h). Called once, from StartDesk.
void StartBrowserWindows();

// Opens a browser window at `url`, for `domicile open`: in browser profile
// `profile`, or for an empty one the profile `url`'s site opens in. Returns
// false when there is no shell to own it.
bool OpenBrowserWindow(const GURL& url, const std::string& profile);

// Opens an app window at `url` with `app_id`, or reuses one as `reuse` says,
// for `domicile open --app`, in browser profile `profile` or for an empty
// one the profile `url`'s site opens in. See mojom::BrowserWindows.OpenApp.
// Returns false when there is no shell to own it.
bool OpenAppWindow(const GURL& url,
                   const std::string& app_id,
                   mojom::AppReuse reuse,
                   const std::string& profile);

// Opens an app window at `url`, an app module's address, pinned to the app
// at `app_host` so it may show that app and no other domicile:// address.
// Returns false when there is no shell to own it. See
// docs/architecture/APP-MODULES.md.
bool OpenAppModuleWindow(const GURL& url, const std::string& app_host);

// Opens an app window at `url` for an Electron app, with `app_id`, in its own
// `partition`, whose pages run `preload` (none when empty) in a renderer told
// `arguments`, as Electron's additionalArguments, and make `calls`.
// A `node` page has Node.js, in a renderer of its own that isn't sandboxed.
// A `view` is a WebContentsView's page, listed only while a window holds it.
// A window shows `title` instead of its page's when it isn't empty, and opens
// `hidden` when asked, and loads as `user_agent` when it isn't empty, over
// `session`'s. With a `history`, its page opens with it, at its entry `url`,
// instead of loading `url`.
// Returns the window's id. Nothing when there is no shell to own it. See
// docs/architecture/ELECTRON-APPS.md.
std::optional<std::string> OpenElectronWindow(
    const GURL& url,
    const std::optional<ElectronHistory>& history,
    const std::string& app_id,
    const WebViewPartition& partition,
    const std::string& preload,
    const std::vector<std::string>& arguments,
    const std::optional<ElectronNode>& node,
    ElectronPageCalls calls,
    base::WeakPtr<ElectronSession> session,
    bool view,
    const std::string& title,
    bool hidden,
    const std::string& user_agent);

// Makes `page`, a page's new window its Electron app allowed, a window of app
// `app_id`: see ElectronDesk::Adopt. Returns the window's id. Nothing when
// there is no shell to own it.
std::optional<std::string> AdoptElectronWindow(
    std::unique_ptr<ElectronHeldPage> page,
    const std::string& app_id,
    const std::string& preload,
    const std::vector<std::string>& arguments,
    const std::optional<ElectronNode>& node,
    ElectronPageCalls calls,
    base::WeakPtr<ElectronSession> session,
    const std::string& title,
    bool hidden,
    const std::string& user_agent);

// Electron window `id`'s own title, listed with it over its page's.
void SetElectronTitle(const std::string& id, const std::string& title);

// Whether Electron window `id` is hidden, listed with it (`isHidden`) for the
// shell to leave out of sight while its page runs.
void SetElectronHidden(const std::string& id, bool hidden);

// The state Electron window `id`'s app asks for it, listed for the shell.
void SetElectronWindowState(const std::string& id, ElectronWindowState state);

// Electron window `id` holds `views`, bottom first, and no others; each is
// listed with it as its parent. A view another window held moves here.
void SetElectronViews(const std::string& id,
                      std::vector<ElectronDeskView> views);

// Electron window `id`'s menu bar, listed with it for the shell to draw.
void SetElectronMenuBar(const std::string& id, ElectronDeskMenuBar bar);

// Asks `box` over Electron window `id`, listed with it for the shell to show,
// and runs `answered` with the button pressed and the checkbox's state. With
// no shell, or once the window closes, the box's cancel button answers.
void ShowElectronMessageBox(const std::string& id,
                            ElectronDeskMessageBox box,
                            base::OnceCallback<void(int, bool)> answered);

// Shows `menu` over Electron window `id`, listed with it for the shell to
// draw, in place of any it shows, and runs `closed` with the entry the user
// chose, or 0 once it is put away. With no shell, it closes at once.
void ShowElectronPopupMenu(const std::string& id,
                           ElectronDeskPopupMenu menu,
                           base::OnceCallback<void(int)> closed);

// Puts away the popup menu Electron window `id` shows, if any.
void CloseElectronPopupMenu(const std::string& id);

// Electron window `id`'s page, for the app's IPC to it, or null after
// logging when no such window is open or its page has no preload.
ElectronPage* ElectronPageOf(const std::string& id);

// Loads `url` in browser window `id` of the shell's profile.
// Browser window `id`'s page loads as `user_agent` from its next navigation
// on, its page's own included: session.setUserAgent for an Electron app's.
void SetBrowserWindowUserAgent(const std::string& id,
                               const std::string& user_agent);
void LoadBrowserWindow(const std::string& id, const GURL& url);

// Browser window `id`'s page, or null when there is no shell or no such
// window.
content::WebContents* BrowserWindowContents(const std::string& id);

// Asks the shell to focus browser window `id` of the shell's profile.
void FocusBrowserWindow(const std::string& id);

// Closes browser window `id` of the shell's profile once its page agrees.
void AskToCloseBrowserWindow(const std::string& id);

// Closes browser window `id` of the shell's profile without asking.
void CloseBrowserWindow(const std::string& id);

// Runs `loaded` with a browser window's id each time its page finishes
// loading, until the subscription goes.
base::CallbackListSubscription WatchBrowserWindowLoads(
    base::RepeatingCallback<void(const std::string& id)> loaded);

// Runs `ready` with a browser window's id each time its main frame's DOM is
// ready, until the subscription goes.
base::CallbackListSubscription WatchBrowserWindowDomReadies(
    base::RepeatingCallback<void(const std::string& id)> ready);

// The shell's WebContents in any profile, or null while there is none.
content::WebContents* DeskShellContents();

// The browser windows whose pages `at`, a point in the shell page's CSS
// pixels, is on, and where on each. Empty while there is no shell.
std::vector<PointerOverWindow> BrowserWindowsAt(const gfx::PointF& at);

// Binds BrowserWindows for `frame`. Sends the whole list on binding and on
// every change, and takes the shell's opens and closes.
//
// Access control is the caller's, as for BindExtensionTray: it registers this
// only for a document whose origin is domicile://.
void BindBrowserWindows(content::RenderFrameHost* frame,
                        mojo::PendingReceiver<mojom::BrowserWindows> receiver);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_BROWSER_WINDOWS_H_
