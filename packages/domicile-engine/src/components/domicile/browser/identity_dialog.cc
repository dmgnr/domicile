// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/identity_dialog.h"

#include <algorithm>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/check.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/logging.h"
#include "base/notreached.h"
#include "base/strings/strcat.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image.h"
#include "url/gurl.h"

namespace domicile {
namespace {

using Action = mojom::WebViewIdentityAction;
using DismissReason = content::IdentityRequestDialogController::DismissReason;
using Step = mojom::WebViewIdentityStep;

// The provider's icon is drawn at 26 CSS pixels, and on a 1.5x display that
// is 39. A smaller one than 16 is too blurry to show, so content drops it.
constexpr int kIconIdealSize = 40;
constexpr int kIconMinimumSize = 16;

// `image` as a data: URL, or empty for none.
std::string DataUrlOf(const gfx::Image& image) {
  if (image.IsEmpty()) {
    return std::string();
  }
  std::optional<std::vector<uint8_t>> png = gfx::PNGCodec::EncodeBGRASkBitmap(
      image.AsBitmap(), /*discard_transparency=*/false);
  if (!png) {
    LOG(ERROR) << "domicile: a sign-in provider's image could not be encoded; "
                  "it is left out.";
    return std::string();
  }
  return base::StrCat({"data:image/png;base64,", base::Base64Encode(*png)});
}

mojom::WebViewIdentityPurpose PurposeOf(blink::mojom::RpContext context) {
  switch (context) {
    case blink::mojom::RpContext::kSignIn:
      return mojom::WebViewIdentityPurpose::kSignIn;
    case blink::mojom::RpContext::kSignUp:
      return mojom::WebViewIdentityPurpose::kSignUp;
    case blink::mojom::RpContext::kUse:
      return mojom::WebViewIdentityPurpose::kUse;
    case blink::mojom::RpContext::kContinue:
      return mojom::WebViewIdentityPurpose::kContinue;
  }
  NOTREACHED();
}

mojom::WebViewIdentityField FieldOf(
    content::IdentityRequestDialogDisclosureField field) {
  switch (field) {
    case content::IdentityRequestDialogDisclosureField::kName:
      return mojom::WebViewIdentityField::kName;
    case content::IdentityRequestDialogDisclosureField::kEmail:
      return mojom::WebViewIdentityField::kEmail;
    case content::IdentityRequestDialogDisclosureField::kUsername:
      return mojom::WebViewIdentityField::kUsername;
    case content::IdentityRequestDialogDisclosureField::kPhoneNumber:
      return mojom::WebViewIdentityField::kPhoneNumber;
    case content::IdentityRequestDialogDisclosureField::kPicture:
      return mojom::WebViewIdentityField::kPicture;
  }
  NOTREACHED();
}

// A request for `step` with the signing-in site's half filled in.
mojom::WebViewIdentityRequestPtr RequestFor(
    Step step,
    const content::RelyingPartyData& rp_data,
    blink::mojom::RpMode rp_mode,
    blink::mojom::RpContext rp_context) {
  auto request = mojom::WebViewIdentityRequest::New();
  request->step = step;
  request->button = rp_mode == blink::mojom::RpMode::kActive;
  request->site = base::UTF16ToUTF8(rp_data.rp_for_display);
  request->frame_site = base::UTF16ToUTF8(rp_data.iframe_for_display);
  request->purpose = PurposeOf(rp_context);
  return request;
}

// A provider known only by its name and config, as the failure, error and
// loading steps give it.
mojom::WebViewIdentityProviderPtr ProviderNamed(
    const std::string& name,
    const content::IdentityProviderMetadata& metadata,
    bool signed_out) {
  auto provider = mojom::WebViewIdentityProvider::New();
  provider->name = name;
  provider->icon = DataUrlOf(metadata.brand_decoded_icon);
  provider->signed_out = signed_out;
  provider->add_account = metadata.supports_add_account;
  return provider;
}

mojom::WebViewIdentityProviderPtr ProviderOf(
    const content::IdentityProviderData& data) {
  mojom::WebViewIdentityProviderPtr provider = ProviderNamed(
      data.idp_for_display, data.idp_metadata, data.has_login_status_mismatch);
  provider->privacy_policy = data.client_metadata.privacy_policy_url;
  provider->terms_of_service = data.client_metadata.terms_of_service_url;
  return provider;
}

// Whether the user signed in to the site with `account` before, as Chrome's
// own controller decides it.
bool IsReturning(const content::IdentityRequestAccount& account) {
  return account.idp_claimed_login_state.value_or(
             account.browser_trusted_login_state) ==
         content::IdentityRequestAccount::LoginState::kSignIn;
}

mojom::WebViewIdentityAccountPtr AccountOf(
    const content::IdentityRequestAccount& account,
    int32_t provider) {
  auto offered = mojom::WebViewIdentityAccount::New();
  offered->provider = provider;
  offered->name = account.display_name;
  offered->identifier = account.display_identifier;
  offered->picture = DataUrlOf(account.decoded_picture);
  offered->returning = IsReturning(account);
  // Chrome says what is shared only when signing up.
  if (!offered->returning) {
    for (content::IdentityRequestDialogDisclosureField field : account.fields) {
      offered->shared.push_back(FieldOf(field));
    }
  }
  return offered;
}

// Content's answer for the user closing a step, or for no answer at all.
// Only the user's own close may embargo the site.
DismissReason DismissalFor(Action action) {
  return action == Action::kDismiss ? DismissReason::kCloseButton
                                    : DismissReason::kOther;
}

void AccountsAnswered(
    std::vector<scoped_refptr<content::IdentityProviderData>> idp_list,
    std::vector<scoped_refptr<content::IdentityRequestAccount>> accounts,
    content::IdentityRequestDialogController::AccountSelectionCallback
        on_selected,
    content::IdentityRequestDialogController::LoginToIdPCallback on_add_account,
    content::IdentityRequestDialogController::DismissCallback dismiss,
    Action action,
    int32_t index) {
  if (action == Action::kChoose && index >= 0 &&
      static_cast<size_t>(index) < accounts.size()) {
    const content::IdentityRequestAccount& account = *accounts[index];
    std::move(on_selected)
        .Run(account.identity_provider->idp_metadata.config_url, account.id,
             IsReturning(account));
    return;
  }
  if (action == Action::kSignInToProvider && index >= 0 &&
      static_cast<size_t>(index) < idp_list.size()) {
    const content::IdentityProviderMetadata& metadata =
        idp_list[index]->idp_metadata;
    on_add_account.Run(metadata.config_url, metadata.idp_login_url);
    return;
  }
  if (action == Action::kChoose || action == Action::kSignInToProvider) {
    LOG(ERROR) << "domicile: the shell answered a sign-in with " << action
               << " " << index << ", which it was never offered; it is "
               << "taken as a no.";
  }
  std::move(dismiss).Run(DismissalFor(action));
}

}  // namespace

IdentityDialog::IdentityDialog(std::unique_ptr<IdentityAsker> asker)
    : asker_(std::move(asker)) {}

IdentityDialog::~IdentityDialog() {
  if (asker_ && open_ != 0) {
    asker_->Withdraw(open_);
  }
}

int IdentityDialog::GetBrandIconIdealSize(blink::mojom::RpMode rp_mode) {
  return kIconIdealSize;
}

int IdentityDialog::GetBrandIconMinimumSize(blink::mojom::RpMode rp_mode) {
  return kIconMinimumSize;
}

bool IdentityDialog::ShowAccountsDialog(
    content::RelyingPartyData rp_data,
    const std::vector<scoped_refptr<content::IdentityProviderData>>& idp_list,
    const std::vector<scoped_refptr<content::IdentityRequestAccount>>& accounts,
    const std::vector<scoped_refptr<content::IdentityRequestAccount>>&
        filtered_accounts,
    blink::mojom::RpMode rp_mode,
    AccountSelectionCallback on_selected,
    LoginToIdPCallback on_add_account,
    DismissCallback dismiss_callback,
    AccountsDisplayedCallback accounts_displayed_callback) {
  if (!asker_) {
    std::move(dismiss_callback).Run(DismissReason::kOther);
    return false;
  }
  mojom::WebViewIdentityRequestPtr request =
      RequestFor(Step::kAccounts, rp_data, rp_mode,
                 idp_list.empty() ? blink::mojom::RpContext::kSignIn
                                  : idp_list.front()->rp_context);
  for (const scoped_refptr<content::IdentityProviderData>& idp : idp_list) {
    request->providers.push_back(ProviderOf(*idp));
  }
  for (const scoped_refptr<content::IdentityRequestAccount>& account :
       accounts) {
    const auto provider =
        std::ranges::find(idp_list, account->identity_provider);
    // Content gives each account one of `idp_list`'s providers.
    CHECK(provider != idp_list.end());
    request->accounts.push_back(
        AccountOf(*account, static_cast<int32_t>(provider - idp_list.begin())));
  }
  Show(std::move(request),
       base::BindOnce(&AccountsAnswered, idp_list, accounts,
                      std::move(on_selected), std::move(on_add_account),
                      std::move(dismiss_callback)));
  std::move(accounts_displayed_callback).Run();
  return true;
}

bool IdentityDialog::ShowFailureDialog(
    const content::RelyingPartyData& rp_data,
    const std::string& idp_for_display,
    blink::mojom::RpContext rp_context,
    blink::mojom::RpMode rp_mode,
    const content::IdentityProviderMetadata& idp_metadata,
    const std::vector<scoped_refptr<content::IdentityRequestAccount>>&
        filtered_accounts,
    DismissCallback dismiss_callback,
    LoginToIdPCallback login_callback) {
  if (!asker_) {
    std::move(dismiss_callback).Run(DismissReason::kOther);
    return false;
  }
  mojom::WebViewIdentityRequestPtr request =
      RequestFor(Step::kSignedOut, rp_data, rp_mode, rp_context);
  request->providers.push_back(
      ProviderNamed(idp_for_display, idp_metadata, /*signed_out=*/true));
  Show(std::move(request),
       base::BindOnce(
           [](GURL config_url, GURL login_url, LoginToIdPCallback login,
              DismissCallback dismiss, Action action, int32_t index) {
             if (action == Action::kSignInToProvider && index == 0) {
               login.Run(config_url, login_url);
               return;
             }
             std::move(dismiss).Run(DismissalFor(action));
           },
           idp_metadata.config_url, idp_metadata.idp_login_url,
           std::move(login_callback), std::move(dismiss_callback)));
  return true;
}

bool IdentityDialog::ShowErrorDialog(
    const content::RelyingPartyData& rp_data,
    const std::string& idp_for_display,
    blink::mojom::RpContext rp_context,
    blink::mojom::RpMode rp_mode,
    const content::IdentityProviderMetadata& idp_metadata,
    const std::optional<content::IdentityCredentialTokenError>& error,
    DismissCallback dismiss_callback,
    MoreDetailsCallback more_details_callback) {
  if (!asker_) {
    std::move(dismiss_callback).Run(DismissReason::kOther);
    return false;
  }
  mojom::WebViewIdentityRequestPtr request =
      RequestFor(Step::kError, rp_data, rp_mode, rp_context);
  request->providers.push_back(
      ProviderNamed(idp_for_display, idp_metadata, /*signed_out=*/false));
  if (error) {
    request->error = error->code;
    // Content gives no details callback without a page to open.
    if (more_details_callback) {
      request->error_url = error->url;
    }
  }
  Show(std::move(request),
       base::BindOnce(
           [](DismissCallback dismiss, MoreDetailsCallback more_details,
              Action action, int32_t index) {
             if (action == Action::kMoreDetails && more_details) {
               std::move(more_details).Run();
               std::move(dismiss).Run(DismissReason::kMoreDetailsButton);
               return;
             }
             // OK is the user's acknowledgment, as Chrome's "Got it".
             std::move(dismiss).Run(action == Action::kDismiss
                                        ? DismissReason::kGotItButton
                                        : DismissReason::kOther);
           },
           std::move(dismiss_callback), std::move(more_details_callback)));
  return true;
}

bool IdentityDialog::ShowLoadingDialog(const content::RelyingPartyData& rp_data,
                                       const std::string& idp_for_display,
                                       blink::mojom::RpContext rp_context,
                                       blink::mojom::RpMode rp_mode,
                                       DismissCallback dismiss_callback) {
  if (!asker_) {
    std::move(dismiss_callback).Run(DismissReason::kOther);
    return false;
  }
  mojom::WebViewIdentityRequestPtr request =
      RequestFor(Step::kLoading, rp_data, rp_mode, rp_context);
  request->providers.push_back(
      ProviderNamed(idp_for_display, content::IdentityProviderMetadata(),
                    /*signed_out=*/false));
  Show(std::move(request),
       base::BindOnce(
           [](DismissCallback dismiss, Action action, int32_t index) {
             std::move(dismiss).Run(DismissalFor(action));
           },
           std::move(dismiss_callback)));
  return true;
}

bool IdentityDialog::ShowVerifyingDialog(
    const content::RelyingPartyData& rp_data,
    const scoped_refptr<content::IdentityProviderData>& idp_data,
    const scoped_refptr<content::IdentityRequestAccount>& account,
    content::IdentityRequestAccount::SignInMode sign_in_mode,
    blink::mojom::RpMode rp_mode,
    AccountsDisplayedCallback accounts_displayed_callback) {
  if (!asker_) {
    return false;
  }
  mojom::WebViewIdentityRequestPtr request =
      RequestFor(Step::kVerifying, rp_data, rp_mode, idp_data->rp_context);
  request->providers.push_back(ProviderOf(*idp_data));
  request->accounts.push_back(AccountOf(*account, /*provider=*/0));
  request->automatic =
      sign_in_mode == content::IdentityRequestAccount::SignInMode::kAuto;
  // Nothing to answer: it ends when the request does.
  Show(std::move(request), base::DoNothing());
  std::move(accounts_displayed_callback).Run();
  return true;
}

content::WebContents* IdentityDialog::ShowModalDialog(
    const GURL& url,
    blink::mojom::RpMode rp_mode,
    DismissCallback dismiss_callback,
    ShownModalAsyncCallback on_shown_async,
    NativeAppResultCallback native_result_callback) {
  content::WebContents* window =
      asker_ ? asker_->OpenWindow(url,
                                  base::BindOnce(&IdentityDialog::WindowClosed,
                                                 weak_factory_.GetWeakPtr()))
             : nullptr;
  if (!window) {
    LOG(WARNING) << "domicile: a sign-in provider's page had no window to "
                    "open in; the sign-in goes on as if it were closed.";
    std::move(dismiss_callback).Run(DismissReason::kOther);
    return nullptr;
  }
  window_dismissed_ = std::move(dismiss_callback);
  return window;
}

void IdentityDialog::CloseModalDialog() {
  window_dismissed_.Reset();
  if (asker_) {
    asker_->CloseWindow();
  }
}

void IdentityDialog::Show(mojom::WebViewIdentityRequestPtr request,
                          Answer answer) {
  open_ = asker_->Ask(
      std::move(request),
      base::BindOnce(&IdentityDialog::Answered, weak_factory_.GetWeakPtr(),
                     ++step_, std::move(answer)));
}

void IdentityDialog::Answered(int step,
                              Answer answer,
                              mojom::WebViewIdentityAction action,
                              int32_t index) {
  if (step != step_) {
    return;
  }
  open_ = 0;
  // May destroy this: content ends the request on some answers.
  std::move(answer).Run(action, index);
}

void IdentityDialog::WindowClosed() {
  if (window_dismissed_) {
    std::move(window_dismissed_).Run(DismissReason::kOther);
  }
}

}  // namespace domicile
