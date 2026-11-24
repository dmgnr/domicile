// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_shell_windows.h"

#include <stddef.h>
#include <stdint.h>

#include <algorithm>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/callback_list.h"
#include "base/check.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/domicile/domicile_cursor_display.h"
#include "chrome/browser/domicile/domicile_desk_presenters.h"
#include "chrome/browser/ui/browser_window/public/browser_collection.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/web_applications/web_app_helpers.h"
#include "components/domicile/browser/cursor_display.h"
#include "components/domicile/browser/desk_geometry.h"
#include "components/domicile/browser/shell_windows.h"
#include "components/domicile/common/domicile_scheme.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/domicile_desk.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/aura/client/aura_constants.h"
#include "ui/aura/domicile/desk_targeter.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/base/base_window.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/base/window_open_disposition.h"
#include "ui/display/display.h"
#include "ui/display/display_observer.h"
#include "ui/display/screen.h"
#include "ui/display/types/display_constants.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/native_ui_types.h"
#include "ui/ozone/public/ozone_platform.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"
#include "ui/views/window/client_view.h"
#include "url/gurl.h"

namespace domicile {
namespace {

// Must match ui/ozone/public/ozone_switches.cc and
// ui/ozone/platform/headless/domicile/headless_desk.h. Copied to avoid a
// dependency on //ui/ozone for three strings.
constexpr char kScanoutPlatform[] = "drm";
constexpr char kOzonePlatformSwitch[] = "ozone-platform";
constexpr char kHeadlessDeskSwitch[] = "domicile-headless-desk";

// Whether this engine drives the displays (DRM or a headless desk), as
// opposed to a nested run.
//
// A nested run's screens are the host session's monitors. Opening windows on
// them would be wrong, and the compositor would not recognize them, so the
// shell would get no screens. `DomicileDisplayWatcher` uses the same gate.
bool ScansOut() {
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  return command_line.GetSwitchValueASCII(kOzonePlatformSwitch) ==
             kScanoutPlatform ||
         command_line.HasSwitch(kHeadlessDeskSwitch);
}

// The desk's page geometry and the places it is laid out on.
struct Desk {
  DeskGeometry geometry;
  std::vector<DeskPlace> places;
};

// The places the compositor's last layout lights among the current displays,
// or `std::nullopt` for an empty layout. See `DeskPlacesKept`.
std::optional<std::vector<DeskPlace>> LitPlacesOf(
    const std::vector<display::Display>& displays) {
  const std::optional<std::vector<content::DomicileDeskDisplay>> laid_out =
      content::GetDomicileDesk();
  if (!laid_out.has_value()) {
    return std::nullopt;
  }
  std::vector<DeskPlace> places;
  for (const content::DomicileDeskDisplay& lit : *laid_out) {
    const auto found =
        std::ranges::find(displays, lit.id, &display::Display::id);
    if (found == displays.end()) {
      continue;
    }
    places.push_back(DeskPlace{.id = lit.id,
                               .desk = lit.desk,
                               .scale = lit.scale,
                               .refresh_hz = found->display_frequency(),
                               .lit = lit.lit});
  }
  return places;
}

// The desk laid out on `places`, or `std::nullopt` for none.
std::optional<Desk> DeskOf(std::vector<DeskPlace> places) {
  const std::optional<DeskGeometry> geometry = DeskGeometryOf(places);
  if (!geometry.has_value()) {
    return std::nullopt;
  }
  return Desk{.geometry = *geometry, .places = std::move(places)};
}

// A shell window and the display nearest its current rectangle.
//
// `nearest` can be wrong during hotplug, when a window at its old rectangle
// overlaps another monitor. `ShellWindowPlaces` resolves the real display.
struct ShellWindow {
  int64_t nearest = display::kInvalidDisplayId;
  raw_ptr<BrowserWindowInterface> window = nullptr;
};

// A window's key in `ShellWindowPlaces`: its pointer as a number, never
// dereferenced.
uintptr_t Identity(BrowserWindowInterface* window) {
  return reinterpret_cast<uintptr_t>(window);
}

bool ShowsAShell(BrowserWindowInterface* browser) {
  tabs::TabInterface* tab = browser->GetActiveTabInterface();
  return tab != nullptr &&
         tab->GetContents()->GetLastCommittedURL().SchemeIs(kDomicileScheme);
}

// Returns every shell window with its nearest display, in creation order.
//
// Read fresh each time because windows can close on their own (a crashed
// renderer, a shell that navigated away). Each window's display is tracked
// separately in `ShellWindowPlaces`, since rectangles are wrong mid-hotplug.
std::vector<ShellWindow> ShellWindowsNow() {
  std::vector<ShellWindow> found;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&found](BrowserWindowInterface* browser) {
        if (!ShowsAShell(browser)) {
          return true;
        }
        ui::BaseWindow* window = browser->GetWindow();
        if (window == nullptr) {
          return true;
        }
        found.push_back(
            ShellWindow{display::Screen::Get()
                            ->GetDisplayNearestWindow(window->GetNativeWindow())
                            .id(),
                        browser});
        return true;
      },
      BrowserCollection::Order::kCreation);
  return found;
}

// Returns browser windows with no committed shell page, including ones this
// opened that are still loading. Passed to `ShellWindowPlaces::Update` as
// `loading`.
std::vector<BrowserWindowInterface*> WindowsStillLoading() {
  std::vector<BrowserWindowInterface*> found;
  GlobalBrowserCollection::GetInstance()->ForEach(
      [&found](BrowserWindowInterface* browser) {
        if (!ShowsAShell(browser)) {
          found.push_back(browser);
        }
        return true;
      },
      BrowserCollection::Order::kCreation);
  return found;
}

std::vector<uintptr_t> IdentitiesOf(
    const std::vector<BrowserWindowInterface*>& windows) {
  std::vector<uintptr_t> identities;
  identities.reserve(windows.size());
  for (BrowserWindowInterface* window : windows) {
    identities.push_back(Identity(window));
  }
  return identities;
}

// Moves `window` to `pixels`, a display's bounds.
//
// Sets the host's bounds directly because display bounds on DRM are CRTC
// pixels (see drm_screen.h), and `BaseWindow::SetBounds` takes DIPs and would
// scale them.
void FitTo(BrowserWindowInterface* window, const gfx::Rect& pixels) {
  window->GetWindow()->GetNativeWindow()->GetHost()->SetBoundsInPixels(pixels);
}

// Converts windows to the form `ShellWindowPlaces` reads.
std::vector<SightedShellWindow> SightingsOf(
    const std::vector<ShellWindow>& held) {
  std::vector<SightedShellWindow> sighted;
  sighted.reserve(held.size());
  for (const ShellWindow& one : held) {
    sighted.push_back(SightedShellWindow{.window = Identity(one.window),
                                         .nearest = one.nearest});
  }
  return sighted;
}

// Reports when a shell window's page commits or its renderer is replaced.
//
// The first reconciliation runs before the shell page commits, so the commit
// triggers the first real layout. A new renderer is a new view, which the
// presenters must mirror.
class ShellPageWatch : public content::WebContentsObserver {
 public:
  ShellPageWatch(content::WebContents* contents, base::RepeatingClosure changed)
      : content::WebContentsObserver(contents), changed_(std::move(changed)) {}

  // content::WebContentsObserver:
  void PrimaryPageChanged(content::Page&) override { changed_.Run(); }
  void RenderViewReady() override { changed_.Run(); }

 private:
  base::RepeatingClosure changed_;
};

// Implements StartShellWindows. See
// docs/architecture/ONE-PAGE-FOR-THE-DESK.md.
class ShellWindows : public display::DisplayObserver {
 public:
  ShellWindows()
      : desk_laid_out_(content::AddDomicileDeskObserver(
            base::BindRepeating(&ShellWindows::ReconcileSoon,
                                // Safe: this is a NoDestructor.
                                base::Unretained(this)))) {
    display::Screen::Get()->AddObserver(this);
    Reconcile();
  }

  ShellWindows(const ShellWindows&) = delete;
  ShellWindows& operator=(const ShellWindows&) = delete;

  ~ShellWindows() override = default;

  // display::DisplayObserver:
  void OnDisplayAdded(const display::Display&) override { ReconcileSoon(); }

  void OnDisplaysRemoved(const display::Displays&) override { ReconcileSoon(); }

  // When a display moves or changes mode, its window must follow. A window
  // whose rectangle no longer matches the CRTC exactly gets no controller,
  // and the screen goes black with nothing logged.
  void OnDisplayMetricsChanged(const display::Display& display,
                               uint32_t changed_metrics) override {
    if ((changed_metrics & DISPLAY_METRIC_BOUNDS) == 0) {
      // Bounds are in pixels, so a new scale or turn moves no window. The
      // pointer is still drawn for the old one until `Present` fits it: after
      // an undock the panel is added at scale 1 and only then scaled, which
      // left the pointer at 1x.
      if (DisplayChangeRefitsPointer(changed_metrics)) {
        ReconcileSoon();
      }
      return;
    }
    const std::vector<ShellWindow> held = ShellWindowsNow();
    const std::vector<BrowserWindowInterface*> loading = WindowsStillLoading();
    // Use tracked places, not nearest displays: the window is still at the
    // display's old rectangle.
    places_.Update(SightingsOf(held), IdentitiesOf(loading));
    // Include loading windows: a new monitor is added, then moved once the
    // compositor's layout names it, while its window is still loading.
    std::vector<BrowserWindowInterface*> windows = loading;
    for (const ShellWindow& one : held) {
      windows.push_back(one.window);
    }
    for (BrowserWindowInterface* window : windows) {
      if (places_.Of(Identity(window)) == display.id()) {
        FitTo(window, display.bounds());
      }
    }
    // Presenter windows are updated by reconciliation.
    ReconcileSoon();
  }

 private:
  // Reconciles in a posted task, once the display list has finished changing.
  //
  // `DrmScreen` calls `OnDisplayAdded` while it is still updating its list, so
  // reconciling inline would see a half-updated desk. Posting also coalesces
  // a burst of changes into one reconciliation.
  void ReconcileSoon() {
    if (reconcile_posted_) {
      return;
    }
    reconcile_posted_ = true;
    // Safe: this is a NoDestructor.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&ShellWindows::ReconcilePosted, base::Unretained(this)));
  }

  void ReconcilePosted() {
    reconcile_posted_ = false;
    Reconcile();
  }

  void Reconcile() {
    CHECK_CURRENTLY_ON(content::BrowserThread::UI);
    if (!display::Screen::HasScreen()) {
      return;
    }
    const std::vector<ShellWindow> held = ShellWindowsNow();
    const std::vector<BrowserWindowInterface*> loading = WindowsStillLoading();
    // Use tracked places, not rectangles: during hotplug the desk moves before
    // the windows do, and rectangles would map two windows to one monitor.
    // See `ShellWindowPlaces`.
    const std::vector<int64_t> placed =
        places_.Update(SightingsOf(held), IdentitiesOf(loading));
    std::vector<int64_t> windowed = placed;
    windowed.reserve(held.size() + loading.size() + opening_.size());
    // Count loading windows so their displays don't get a second window.
    for (BrowserWindowInterface* window : loading) {
      const int64_t on = places_.Of(Identity(window));
      if (on != display::kInvalidDisplayId) {
        windowed.push_back(on);
      }
    }
    // Count windows still being created (`CreateBrowserWindow` is async) so a
    // second hotplug in that gap doesn't open another.
    for (int64_t coming : opening_) {
      windowed.push_back(coming);
    }
    // Copy: `GetAllDisplays` returns the screen's own vector, which opening and
    // closing windows below can reallocate.
    const std::vector<display::Display> all =
        display::Screen::Get()->GetAllDisplays();
    // Only the host display gets a shell window; the others get presenters.
    // Until the compositor sends a layout, the primary display hosts. An empty
    // layout lays the desk out where the hardware put each display, and a
    // blank keeps the desk it turned off; see `DeskPlacesKept`.
    places_kept_ = DeskPlacesKept(LitPlacesOf(all), places_kept_, all);
    const std::optional<Desk> desk = DeskOf(places_kept_);
    std::vector<display::Display> displays = all;
    if (!all.empty()) {
      const int64_t host =
          desk.has_value() ? desk->geometry.host : all.front().id();
      std::erase_if(displays, [host](const display::Display& display) {
        return display.id() != host;
      });
    }
    const ShellWindowPlan plan = ShellWindowsFor(displays, windowed);

    for (const ShellWindowMove& move : plan.move) {
      Move(move, displays, held, placed);
    }
    // Open before closing: briefly having zero windows would exit the browser.
    // See `shell_windows.h`.
    for (int64_t id : plan.open) {
      Open(id, displays, held);
    }
    // Read places again: a window just moved must not be closed as the
    // window on the display it left.
    std::vector<int64_t> placed_now;
    placed_now.reserve(held.size());
    for (const ShellWindow& one : held) {
      placed_now.push_back(places_.Of(Identity(one.window)));
    }
    for (int64_t id : plan.close) {
      Close(id, held, placed_now);
    }
    FitMisplaced(held, all);
    Watch();
    Present(desk, all);
    // See `Move`.
    ui::OzonePlatform::GetInstance()->SetDomicilePointerStays(
        gfx::kNullAcceleratedWidget);
  }

  // Fits each of `held` that is on one of `all` to that display's rectangle.
  // See `ShellWindowsToFit`.
  void FitMisplaced(const std::vector<ShellWindow>& held,
                    const std::vector<display::Display>& all) {
    std::vector<ShellWindowBounds> windows;
    for (const ShellWindow& one : held) {
      windows.push_back(ShellWindowBounds{.window = Identity(one.window),
                                          .pixels = one.window->GetWindow()
                                                        ->GetNativeWindow()
                                                        ->GetHost()
                                                        ->GetBoundsInPixels()});
    }
    for (const ShellWindowBounds& fit :
         ShellWindowsToFit(places_, windows, all)) {
      for (const ShellWindow& one : held) {
        if (Identity(one.window) == fit.window) {
          FitTo(one.window, fit.pixels);
        }
      }
    }
  }

  // Watches every browser window's page so page changes trigger
  // reconciliation. Drops watches whose contents are gone.
  void Watch() {
    std::erase_if(watches_, [](const std::unique_ptr<ShellPageWatch>& watch) {
      return watch->web_contents() == nullptr;
    });
    GlobalBrowserCollection::GetInstance()->ForEach(
        [this](BrowserWindowInterface* browser) {
          tabs::TabInterface* tab = browser->GetActiveTabInterface();
          if (tab == nullptr) {
            return true;
          }
          content::WebContents* contents = tab->GetContents();
          if (std::ranges::none_of(
                  watches_,
                  [contents](const std::unique_ptr<ShellPageWatch>& watch) {
                    return watch->web_contents() == contents;
                  })) {
            watches_.push_back(std::make_unique<ShellPageWatch>(
                contents,
                // Safe: this is a NoDestructor.
                base::BindRepeating(&ShellWindows::ReconcileSoon,
                                    base::Unretained(this))));
          }
          return true;
        },
        BrowserCollection::Order::kCreation);
  }

  // Lays out the host's page over the desk and presents it on the other
  // displays. Runs on every reconciliation, since any input may have changed.
  void Present(const std::optional<Desk>& desk,
               const std::vector<display::Display>& all) {
    BrowserWindowInterface* host = nullptr;
    if (desk.has_value()) {
      for (const ShellWindow& one : ShellWindowsNow()) {
        if (places_.Of(Identity(one.window)) == desk->geometry.host) {
          host = one.window;
          break;
        }
      }
    }
    if (host == nullptr) {
      ui::OzonePlatform::GetInstance()->SetDomicileDeskHost(
          gfx::kNullAcceleratedWidget);
      presenters_.Present(nullptr, gfx::Rect(), {});
      return;
    }
    const auto on_host =
        std::ranges::find(desk->places, desk->geometry.host, &DeskPlace::id);
    gfx::NativeWindow window = host->GetWindow()->GetNativeWindow();
    // Route all input, on every monitor, to the host.
    ui::OzonePlatform::GetInstance()->SetDomicileDeskHost(
        window->GetHost()->GetAcceleratedWidget());
    // And draw the pointer for the host's display, which a hotplug can leave
    // it drawn for a display that is gone.
    FitCursorToDisplayOf(window->GetRootWindow());
    const gfx::Rect page = PageBoundsOn(*on_host, desk->geometry.box);
    if (content::GetDomicileDeskPageBounds(window) != page) {
      content::SetDomicileDeskPageBounds(window, page);
      views::Widget* widget = views::Widget::GetWidgetForNativeWindow(window);
      widget->client_view()->InvalidateLayout();
      // Lays the host out before the screen infos below, which place each
      // monitor by the page's position on screen. The renderer reads its
      // regions as those monitors less its own position, so a stale position
      // shifts every region by the distance the host moved.
      widget->LayoutRootViewIfNecessary();
    }
    content::WebContents* contents =
        host->GetActiveTabInterface()->GetContents();
    // Send events outside the host window's bounds (other monitors) to the
    // page.
    aura::TargetDeskPage(window->GetRootWindow(), contents->GetNativeView());
    // Fit the page's tooltips on the monitor each opens on (patch 0160).
    window->GetRootWindow()->SetProperty(
        aura::client::kDomicileDeskMonitorsKey,
        MonitorsOnHost(desk->places, desk->geometry.host));
    content::SetDomicileDeskScreenInfos(
        contents,
        DeskScreenInfos(desk->geometry, desk->places,
                        display::Screen::Get()
                            ->GetScreenInfosNearestDisplay(desk->geometry.host)
                            .current()));

    std::vector<Presented> presented;
    for (const DeskPlace& place : desk->places) {
      // A sleeping display shows nothing until it wakes.
      if (place.id == desk->geometry.host || !place.lit) {
        continue;
      }
      const auto found =
          std::ranges::find(all, place.id, &display::Display::id);
      presented.push_back(
          Presented{.display = place.id,
                    .pixels = found->bounds(),
                    .page = PageBoundsOn(place, desk->geometry.box)});
    }
    presenters_.Present(contents, page, presented);
  }

  // Opens a copy of the existing shell window (same profile and URL) on
  // display `id`.
  void Open(int64_t id,
            const std::vector<display::Display>& displays,
            const std::vector<ShellWindow>& held) {
    // Log every early return: a missing window leaves a monitor dark, which is
    // hard to debug without a log line.
    if (held.empty()) {
      // Normal at startup: the shell page has not committed yet.
      // `ShellPageWatch` reconciles again when it does.
      VLOG(1) << "domicile: display " << id
              << " wants a shell window and there is no shell to copy yet";
      return;
    }
    const display::Display* wanted = nullptr;
    for (const display::Display& display : displays) {
      if (display.id() == id) {
        wanted = &display;
        break;
      }
    }
    if (wanted == nullptr) {
      // The display was removed after planning; the next reconciliation
      // handles it.
      VLOG(1) << "domicile: display " << id << " went before its window came";
      return;
    }
    BrowserWindowInterface* shell = held.front().window;
    tabs::TabInterface* tab = shell->GetActiveTabInterface();
    if (tab == nullptr) {
      LOG(ERROR) << "domicile: the shell window has no tab to copy, so "
                    "display "
                 << id << " stays dark";
      return;
    }
    const GURL url = tab->GetContents()->GetLastCommittedURL();

    // `display_id` is ChromeOS-only, so place the window by the display's
    // bounds. Start fullscreen so no frame is drawn on the wrong monitor.
    BrowserWindowCreateParams params = BrowserWindowCreateParams::CreateForApp(
        web_app::GenerateApplicationNameFromURL(url),
        /*trusted_source=*/true, wanted->bounds(), shell->GetProfile(),
        /*user_gesture=*/false);
    params.initial_show_state = ui::mojom::WindowShowState::kFullscreen;
    // These windows depend on which monitors are attached, so never restore
    // them from a session.
    params.omit_from_session_restore = true;
    params.should_trigger_session_restore = false;

    VLOG(1) << "domicile: opening a shell window on display " << id << " at "
            << wanted->bounds().ToString();
    opening_.push_back(id);
    // Async because the sync form may return an uninitialized window, and
    // `OpenGURL` on one crashes. `base::Unretained` is safe: this is a
    // NoDestructor.
    CreateBrowserWindow(
        std::move(params),
        base::BindOnce(&ShellWindows::Opened, base::Unretained(this), id, url));
  }

  // Handles the result of opening a window on display `id`.
  void Opened(int64_t id, const GURL& url, BrowserWindowInterface* window) {
    std::erase(opening_, id);
    if (window == nullptr) {
      LOG(ERROR) << "domicile: no shell window for display " << id
                 << "; it stays dark until something asks again";
      return;
    }
    // Record the display before reconciling. Don't infer it from bounds,
    // which a hotplug could invalidate first.
    places_.Place(Identity(window), id);
    // Fit to the display's current bounds: a new monitor can move while its
    // window is being created, and `OnDisplayMetricsChanged` missed this
    // window.
    const std::vector<display::Display> displays =
        display::Screen::Get()->GetAllDisplays();
    const auto now = std::ranges::find(displays, id, &display::Display::id);
    if (now == displays.end()) {
      // The display is gone. The window is still recorded on it, so the next
      // reconciliation closes it.
      VLOG(1) << "domicile: display " << id << " went before its window came";
    } else {
      FitTo(window, now->bounds());
    }
    window->OpenGURL(url, WindowOpenDisposition::kCurrentTab);
    // The last reconciliation ran before this window existed, so nothing
    // watches its page. The next one watches it, or presents it if it
    // already committed.
    ReconcileSoon();
  }

  // Moves the shell window on display `move.from` to `move.to`, keeping its
  // page. The host moves when its display sleeps, wakes or is unplugged, and a
  // new window there would restart the shell.
  //
  // A window still loading or opening on `move.from` is not in `held`. It is
  // placed there once it commits or opens, and the next reconciliation moves
  // it.
  void Move(const ShellWindowMove& move,
            const std::vector<display::Display>& displays,
            const std::vector<ShellWindow>& held,
            const std::vector<int64_t>& placed) {
    const auto to = std::ranges::find(displays, move.to, &display::Display::id);
    CHECK(to != displays.end()) << "planned a move to display " << move.to
                                << ", which is not on the desk";
    for (size_t index = 0; index < held.size(); ++index) {
      if (placed[index] == move.from) {
        VLOG(1) << "domicile: moving the shell window from display "
                << move.from << " to display " << move.to;
        places_.Move(Identity(held[index].window), move.to);
        // The pointer stays where it is on screen. Carried along with the
        // window, a pointer on another monitor would land on the host's new
        // one, and the shell's focus would follow it there. `Reconcile`
        // clears this once `Present` opened the presenter for the display
        // the host left, which takes a pointer that was there.
        ui::OzonePlatform* const platform = ui::OzonePlatform::GetInstance();
        platform->SetDomicilePointerStays(held[index]
                                              .window->GetWindow()
                                              ->GetNativeWindow()
                                              ->GetHost()
                                              ->GetAcceleratedWidget());
        FitTo(held[index].window, to->bounds());
        return;
      }
    }
    VLOG(1) << "domicile: the shell window for display " << move.from
            << " is still loading; it moves to display " << move.to
            << " once it is placed";
  }

  void Close(int64_t id,
             const std::vector<ShellWindow>& held,
             const std::vector<int64_t>& placed) {
    for (size_t index = 0; index < held.size(); ++index) {
      if (placed[index] == id) {
        VLOG(1) << "domicile: closing the shell window on display " << id
                << ", which is no longer there";
        held[index].window->GetWindow()->Close();
        return;
      }
    }
  }

  // Displays with a window being created.
  std::vector<int64_t> opening_;
  bool reconcile_posted_ = false;
  ShellWindowPlaces places_;
  // The places the desk was last laid out on.
  std::vector<DeskPlace> places_kept_;
  DeskPresenters presenters_;
  std::vector<std::unique_ptr<ShellPageWatch>> watches_;
  base::CallbackListSubscription desk_laid_out_;
};

}  // namespace

void StartShellWindows() {
  CHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (!ScansOut()) {
    // See `ScansOut`.
    return;
  }
  // Lives for the life of the browser.
  static base::NoDestructor<ShellWindows> windows;
}

}  // namespace domicile
