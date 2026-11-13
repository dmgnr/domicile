// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_IDENTITY_DIALOG_H_
#define COMPONENTS_DOMICILE_BROWSER_IDENTITY_DIALOG_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "content/public/browser/webid/identity_request_account.h"
#include "content/public/browser/webid/identity_request_dialog_controller.h"
#include "third_party/blink/public/mojom/webid/federated_request.mojom-shared.h"

class GURL;

namespace content {
class WebContents;
}  // namespace content

namespace domicile {

// Where an IdentityDialog asks: a page's <webview>, or a test's fake.
class IdentityAsker {
 public:
  using Answered = base::OnceCallback<void(mojom::WebViewIdentityAction action,
                                           int32_t index)>;

  virtual ~IdentityAsker() = default;

  // Asks the shell to show `request`. `answered` gets the answer, always on a
  // later task: kNone when the shell ignored it or the element went away.
  // Returns its number, for Withdraw.
  virtual int Ask(mojom::WebViewIdentityRequestPtr request,
                  Answered answered) = 0;

  // Stops asking request `id`. Does nothing once it was answered or a newer
  // one replaced it.
  virtual void Withdraw(int id) = 0;

  // Opens a browser window at `url` and returns its page, or null when there
  // is nowhere to open one. `closed` runs when that window closes, unless
  // CloseWindow closed it.
  virtual content::WebContents* OpenWindow(const GURL& url,
                                           base::OnceClosure closed) = 0;

  // Closes the window OpenWindow opened last, if it is still open.
  virtual void CloseWindow() = 0;
};

// A site's "Sign in with" (FedCM) dialogs, asked of the shell. Chrome draws
// them itself, over the outermost window, which for a <webview> is the
// shell's.
//
// - Content makes one per request, through
//   ContentBrowserClient::CreateIdentityRequestDialogController, and calls a
//   Show method for each step: loading, the accounts, signed out, verifying
//   and an error. See mojom::WebViewIdentityStep.
// - Each step replaces the one the shell shows. The step open when the
//   request ends is withdrawn, since content destroys this with it.
// - The provider's own pages (its sign-in page, a continuation, an error's
//   details) open as browser windows. Its page closes one through
//   `IdentityProvider.close()`, which content passes to CloseModalDialog. One
//   left open when the request ends stays, as Chrome's popup does.
// - With no asker, for a page outside any <webview>, every step is refused,
//   as content's own controller refuses them.
class IdentityDialog final : public content::IdentityRequestDialogController {
 public:
  explicit IdentityDialog(std::unique_ptr<IdentityAsker> asker);
  IdentityDialog(const IdentityDialog&) = delete;
  IdentityDialog& operator=(const IdentityDialog&) = delete;
  ~IdentityDialog() override;

  // content::IdentityRequestDialogController:
  int GetBrandIconIdealSize(blink::mojom::RpMode rp_mode) override;
  int GetBrandIconMinimumSize(blink::mojom::RpMode rp_mode) override;
  bool ShowAccountsDialog(
      content::RelyingPartyData rp_data,
      const std::vector<scoped_refptr<content::IdentityProviderData>>& idp_list,
      const std::vector<scoped_refptr<content::IdentityRequestAccount>>&
          accounts,
      const std::vector<scoped_refptr<content::IdentityRequestAccount>>&
          filtered_accounts,
      blink::mojom::RpMode rp_mode,
      AccountSelectionCallback on_selected,
      LoginToIdPCallback on_add_account,
      DismissCallback dismiss_callback,
      AccountsDisplayedCallback accounts_displayed_callback) override;
  bool ShowFailureDialog(
      const content::RelyingPartyData& rp_data,
      const std::string& idp_for_display,
      blink::mojom::RpContext rp_context,
      blink::mojom::RpMode rp_mode,
      const content::IdentityProviderMetadata& idp_metadata,
      const std::vector<scoped_refptr<content::IdentityRequestAccount>>&
          filtered_accounts,
      DismissCallback dismiss_callback,
      LoginToIdPCallback login_callback) override;
  bool ShowErrorDialog(
      const content::RelyingPartyData& rp_data,
      const std::string& idp_for_display,
      blink::mojom::RpContext rp_context,
      blink::mojom::RpMode rp_mode,
      const content::IdentityProviderMetadata& idp_metadata,
      const std::optional<content::IdentityCredentialTokenError>& error,
      DismissCallback dismiss_callback,
      MoreDetailsCallback more_details_callback) override;
  bool ShowLoadingDialog(const content::RelyingPartyData& rp_data,
                         const std::string& idp_for_display,
                         blink::mojom::RpContext rp_context,
                         blink::mojom::RpMode rp_mode,
                         DismissCallback dismiss_callback) override;
  bool ShowVerifyingDialog(
      const content::RelyingPartyData& rp_data,
      const scoped_refptr<content::IdentityProviderData>& idp_data,
      const scoped_refptr<content::IdentityRequestAccount>& account,
      content::IdentityRequestAccount::SignInMode sign_in_mode,
      blink::mojom::RpMode rp_mode,
      AccountsDisplayedCallback accounts_displayed_callback) override;
  content::WebContents* ShowModalDialog(
      const GURL& url,
      blink::mojom::RpMode rp_mode,
      DismissCallback dismiss_callback,
      ShownModalAsyncCallback on_shown_async,
      NativeAppResultCallback native_result_callback) override;
  void CloseModalDialog() override;

 private:
  using Answer = base::OnceCallback<void(mojom::WebViewIdentityAction action,
                                         int32_t index)>;

  // Asks the shell `request` in place of the step it shows, and runs `answer`
  // with the shell's answer unless a newer step replaced it first.
  void Show(mojom::WebViewIdentityRequestPtr request, Answer answer);
  void Answered(int step,
                Answer answer,
                mojom::WebViewIdentityAction action,
                int32_t index);

  // The provider's window closed without CloseModalDialog.
  void WindowClosed();

  // Null for a page outside any <webview>.
  const std::unique_ptr<IdentityAsker> asker_;
  // Numbers the steps, so an answer to a replaced one is ignored.
  int step_ = 0;
  // The asker's number for the step the shell shows, or 0.
  int open_ = 0;
  // Content's callback for the provider's window closing, until it closes or
  // CloseModalDialog closes it.
  DismissCallback window_dismissed_;

  base::WeakPtrFactory<IdentityDialog> weak_factory_{this};
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_IDENTITY_DIALOG_H_
