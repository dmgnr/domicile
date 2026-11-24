// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_identity_dialog.h"

#include <memory>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/logging.h"
#include "base/memory/weak_ptr.h"
#include "base/task/bind_post_task.h"
#include "components/domicile/browser/identity_dialog.h"
#include "components/domicile/browser/web_view_guest.h"
#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "url/gurl.h"

namespace domicile {
namespace {

// Runs `closed` when the provider's window's page is destroyed, which is
// after the window closes.
class WindowWatch final : public content::WebContentsObserver {
 public:
  WindowWatch(content::WebContents& window, base::OnceClosure closed)
      : WebContentsObserver(&window), closed_(std::move(closed)) {}

  void WebContentsDestroyed() override {
    Observe(nullptr);
    std::move(closed_).Run();
  }

 private:
  base::OnceClosure closed_;
};

// Asks a page's <webview>.
class GuestAsker final : public IdentityAsker {
 public:
  explicit GuestAsker(WebViewGuest& guest) : guest_(guest.GetWeakPtr()) {}

  int Ask(mojom::WebViewIdentityRequestPtr request,
          Answered answered) override {
    // Always answered on a later task. The answer may end the request and
    // destroy the dialog, which is still inside Ask. Mojo runs it at once
    // when the element's pipe is already gone, and so would this for a guest
    // that is.
    Answered later = base::BindPostTaskToCurrentDefault(std::move(answered));
    if (!guest_) {
      std::move(later).Run(mojom::WebViewIdentityAction::kNone, 0);
      return 0;
    }
    return guest_->AskIdentity(std::move(request), std::move(later));
  }

  void Withdraw(int id) override {
    if (guest_) {
      guest_->WithdrawIdentity(id);
    }
  }

  content::WebContents* OpenWindow(const GURL& url,
                                   base::OnceClosure closed) override {
    WebViewGuest* window = guest_ ? guest_->OpenWindowAt(url) : nullptr;
    if (window == nullptr) {
      return nullptr;
    }
    LOG(INFO) << "domicile: opened a sign-in provider's page in a browser "
                 "window.";
    window_ = window->GetWeakPtr();
    watch_ =
        std::make_unique<WindowWatch>(window->contents(), std::move(closed));
    return &window->contents();
  }

  void CloseWindow() override {
    watch_.reset();
    if (window_) {
      window_->AskToClose();
    }
  }

 private:
  base::WeakPtr<WebViewGuest> guest_;
  // The provider's window, while it is open, and its watch until CloseWindow.
  base::WeakPtr<WebViewGuest> window_;
  std::unique_ptr<WindowWatch> watch_;
};

}  // namespace

std::unique_ptr<content::IdentityRequestDialogController> MakeIdentityDialog(
    content::WebContents* web_contents) {
  WebViewGuest* guest =
      web_contents ? WebViewGuest::FromWebContents(web_contents) : nullptr;
  if (guest == nullptr) {
    LOG(WARNING) << "domicile: a page outside any <webview> signs in with an "
                    "identity provider; it is refused.";
    return std::make_unique<IdentityDialog>(nullptr);
  }
  return std::make_unique<IdentityDialog>(std::make_unique<GuestAsker>(*guest));
}

}  // namespace domicile
