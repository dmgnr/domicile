// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/identity_dialog.h"

#include <memory>
#include <optional>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ref.h"
#include "base/memory/scoped_refptr.h"
#include "components/domicile/mojom/web_view_guest.mojom.h"
#include "content/public/browser/webid/identity_request_account.h"
#include "content/public/browser/webid/identity_request_dialog_controller.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/blink/public/mojom/webid/federated_request.mojom-shared.h"
#include "ui/gfx/image/image.h"
#include "url/gurl.h"

namespace domicile {
namespace {

using Action = mojom::WebViewIdentityAction;
using Account = content::IdentityRequestAccount;
using DismissReason = content::IdentityRequestDialogController::DismissReason;
using Field = content::IdentityRequestDialogDisclosureField;
using Provider = content::IdentityProviderData;
using Step = mojom::WebViewIdentityStep;

const GURL kConfig("https://idp.example/config.json");
const GURL kLogin("https://idp.example/login");

// What the shell was asked and what it was told to stop asking.
struct Asked {
  std::vector<mojom::WebViewIdentityRequestPtr> requests;
  std::vector<IdentityAsker::Answered> answers;
  std::vector<int> withdrawn;
};

// The shell: keeps each request and its answer callback in `asked`.
class FakeAsker final : public IdentityAsker {
 public:
  explicit FakeAsker(Asked& asked) : asked_(asked) {}

  int Ask(mojom::WebViewIdentityRequestPtr request,
          Answered answered) override {
    asked_->requests.push_back(std::move(request));
    asked_->answers.push_back(std::move(answered));
    return static_cast<int>(asked_->requests.size());
  }

  void Withdraw(int id) override { asked_->withdrawn.push_back(id); }

  // No browser window in a unit test.
  content::WebContents* OpenWindow(const GURL& url,
                                   base::OnceClosure closed) override {
    return nullptr;
  }

  void CloseWindow() override {}

 private:
  const raw_ref<Asked> asked_;
};

scoped_refptr<Provider> MakeProvider() {
  content::IdentityProviderMetadata metadata;
  metadata.config_url = kConfig;
  metadata.idp_login_url = kLogin;
  metadata.supports_add_account = true;
  return base::MakeRefCounted<Provider>(
      "idp.example", metadata,
      content::ClientMetadata(GURL("https://rp.example/terms"),
                              GURL("https://rp.example/privacy"), GURL(),
                              gfx::Image()),
      blink::mojom::RpContext::kSignIn, /*format=*/std::nullopt,
      std::vector<Field>{Field::kName, Field::kEmail},
      /*has_login_status_mismatch=*/false);
}

scoped_refptr<Account> MakeAccount(const std::string& id,
                                   Account::LoginState state,
                                   std::vector<Field> fields,
                                   scoped_refptr<Provider> provider) {
  auto account = base::MakeRefCounted<Account>(
      id, /*display_identifier=*/id + "@idp.example",
      /*display_name=*/"Alex " + id, /*email=*/id + "@idp.example",
      /*name=*/"Alex " + id, /*given_name=*/"Alex", /*picture=*/GURL(),
      /*phone=*/std::string(), /*username=*/std::string(),
      /*potentially_approved_site_hashes=*/std::vector<std::string>(),
      /*login_hints=*/std::vector<std::string>(),
      /*domain_hints=*/std::vector<std::string>(),
      /*labels=*/std::vector<std::string>(),
      /*idp_claimed_login_state=*/std::nullopt,
      /*browser_trusted_login_state=*/state);
  account->identity_provider = std::move(provider);
  account->fields = std::move(fields);
  return account;
}

// What the page's request was told.
struct Told {
  std::optional<std::tuple<GURL, std::string, bool>> selected;
  std::optional<std::pair<GURL, GURL>> login;
  std::optional<DismissReason> dismissed;
  bool more_details = false;
};

// Shows the accounts dialog: a new account that shares a name and an email,
// and a returning one.
bool ShowAccounts(IdentityDialog& dialog, Told& told) {
  scoped_refptr<Provider> provider = MakeProvider();
  return dialog.ShowAccountsDialog(
      content::RelyingPartyData(u"rp.example", u""), {provider},
      {MakeAccount("new", Account::LoginState::kSignUp,
                   {Field::kName, Field::kEmail}, provider),
       MakeAccount("back", Account::LoginState::kSignIn, {}, provider)},
      /*filtered_accounts=*/{}, blink::mojom::RpMode::kPassive,
      base::BindOnce(
          [](Told* told, const GURL& config, const std::string& id,
             bool is_sign_in) {
            told->selected = std::make_tuple(config, id, is_sign_in);
          },
          &told),
      base::BindRepeating(
          [](Told* told, const GURL& config, GURL login) {
            told->login = std::make_pair(config, login);
          },
          &told),
      base::BindOnce(
          [](Told* told, DismissReason reason) { told->dismissed = reason; },
          &told),
      base::DoNothing());
}

TEST(IdentityDialogTest, TheAccountsAreAskedWithWhatEachShares) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  EXPECT_TRUE(ShowAccounts(dialog, told));
  ASSERT_EQ(asked.requests.size(), 1u);
  const mojom::WebViewIdentityRequest& request = *asked.requests[0];
  EXPECT_EQ(request.step, Step::kAccounts);
  EXPECT_FALSE(request.button);
  EXPECT_EQ(request.site, "rp.example");
  EXPECT_EQ(request.purpose, mojom::WebViewIdentityPurpose::kSignIn);
  ASSERT_EQ(request.providers.size(), 1u);
  EXPECT_EQ(request.providers[0]->name, "idp.example");
  EXPECT_EQ(request.providers[0]->privacy_policy,
            GURL("https://rp.example/privacy"));
  EXPECT_TRUE(request.providers[0]->add_account);
  ASSERT_EQ(request.accounts.size(), 2u);
  EXPECT_EQ(request.accounts[0]->name, "Alex new");
  EXPECT_EQ(request.accounts[0]->identifier, "new@idp.example");
  EXPECT_FALSE(request.accounts[0]->returning);
  EXPECT_EQ(request.accounts[0]->shared,
            (std::vector<mojom::WebViewIdentityField>{
                mojom::WebViewIdentityField::kName,
                mojom::WebViewIdentityField::kEmail}));
  EXPECT_TRUE(request.accounts[1]->returning);
  EXPECT_TRUE(request.accounts[1]->shared.empty());
}

TEST(IdentityDialogTest, ChoosingAnAccountSignsInWithIt) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  ShowAccounts(dialog, told);
  std::move(asked.answers[0]).Run(Action::kChoose, 1);
  EXPECT_EQ(told.selected, std::make_tuple(kConfig, std::string("back"), true));
  EXPECT_FALSE(told.dismissed);
}

TEST(IdentityDialogTest, SigningInToAProviderOpensItsSignInPage) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  ShowAccounts(dialog, told);
  std::move(asked.answers[0]).Run(Action::kSignInToProvider, 0);
  EXPECT_EQ(told.login, std::make_pair(kConfig, kLogin));
  EXPECT_FALSE(told.dismissed);
}

// Closing it is the user's no, which content may embargo; no answer at all
// is not.
TEST(IdentityDialogTest, OnlyTheUsersCloseIsTheCloseButton) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told closed;
  ShowAccounts(dialog, closed);
  std::move(asked.answers[0]).Run(Action::kDismiss, 0);
  EXPECT_EQ(closed.dismissed, DismissReason::kCloseButton);

  Told unanswered;
  ShowAccounts(dialog, unanswered);
  std::move(asked.answers[1]).Run(Action::kNone, 0);
  EXPECT_EQ(unanswered.dismissed, DismissReason::kOther);
}

// An answer naming an account that was never offered signs in with nothing.
TEST(IdentityDialogTest, AnAccountNeverOfferedIsADismissal) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  ShowAccounts(dialog, told);
  std::move(asked.answers[0]).Run(Action::kChoose, 2);
  EXPECT_FALSE(told.selected);
  EXPECT_EQ(told.dismissed, DismissReason::kOther);
}

// The shell answers the step it was showing, which a newer step replaced.
TEST(IdentityDialogTest, AReplacedStepsAnswerIsIgnored) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  ShowAccounts(dialog, told);
  scoped_refptr<Provider> provider = MakeProvider();
  EXPECT_TRUE(dialog.ShowVerifyingDialog(
      content::RelyingPartyData(u"rp.example", u""), provider,
      MakeAccount("back", Account::LoginState::kSignIn, {}, provider),
      Account::SignInMode::kAuto, blink::mojom::RpMode::kPassive,
      base::DoNothing()));
  ASSERT_EQ(asked.requests.size(), 2u);
  EXPECT_EQ(asked.requests[1]->step, Step::kVerifying);
  EXPECT_TRUE(asked.requests[1]->automatic);
  ASSERT_EQ(asked.requests[1]->accounts.size(), 1u);
  EXPECT_EQ(asked.requests[1]->accounts[0]->name, "Alex back");

  std::move(asked.answers[0]).Run(Action::kChoose, 0);
  EXPECT_FALSE(told.selected);
  EXPECT_FALSE(told.dismissed);
}

TEST(IdentityDialogTest, EndingTheRequestWithdrawsItsStep) {
  Asked asked;
  auto dialog =
      std::make_unique<IdentityDialog>(std::make_unique<FakeAsker>(asked));
  Told told;
  ShowAccounts(*dialog, told);
  dialog.reset();
  EXPECT_EQ(asked.withdrawn, std::vector<int>{1});
}

TEST(IdentityDialogTest, MoreDetailsOpensTheErrorsPageAndCloses) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  content::IdentityProviderMetadata metadata;
  metadata.config_url = kConfig;
  EXPECT_TRUE(dialog.ShowErrorDialog(
      content::RelyingPartyData(u"rp.example", u""), "idp.example",
      blink::mojom::RpContext::kSignIn, blink::mojom::RpMode::kActive, metadata,
      content::IdentityCredentialTokenError{"access_denied",
                                            GURL("https://idp.example/why")},
      base::BindOnce(
          [](Told* told, DismissReason reason) { told->dismissed = reason; },
          &told),
      base::BindOnce([](Told* told) { told->more_details = true; }, &told)));
  const mojom::WebViewIdentityRequest& request = *asked.requests[0];
  EXPECT_EQ(request.step, Step::kError);
  EXPECT_TRUE(request.button);
  EXPECT_EQ(request.error, "access_denied");
  EXPECT_EQ(request.error_url, GURL("https://idp.example/why"));

  std::move(asked.answers[0]).Run(Action::kMoreDetails, 0);
  EXPECT_TRUE(told.more_details);
  EXPECT_EQ(told.dismissed, DismissReason::kMoreDetailsButton);
}

// A signed-out provider's sign-in page is what the shell offers.
TEST(IdentityDialogTest, SignedOutOffersTheProvidersSignInPage) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  Told told;
  content::IdentityProviderMetadata metadata;
  metadata.config_url = kConfig;
  metadata.idp_login_url = kLogin;
  EXPECT_TRUE(dialog.ShowFailureDialog(
      content::RelyingPartyData(u"rp.example", u""), "idp.example",
      blink::mojom::RpContext::kSignUp, blink::mojom::RpMode::kPassive,
      metadata, /*filtered_accounts=*/{},
      base::BindOnce(
          [](Told* told, DismissReason reason) { told->dismissed = reason; },
          &told),
      base::BindRepeating(
          [](Told* told, const GURL& config, GURL login) {
            told->login = std::make_pair(config, login);
          },
          &told)));
  const mojom::WebViewIdentityRequest& request = *asked.requests[0];
  EXPECT_EQ(request.step, Step::kSignedOut);
  EXPECT_EQ(request.purpose, mojom::WebViewIdentityPurpose::kSignUp);
  ASSERT_EQ(request.providers.size(), 1u);
  EXPECT_TRUE(request.providers[0]->signed_out);

  std::move(asked.answers[0]).Run(Action::kSignInToProvider, 0);
  EXPECT_EQ(told.login, std::make_pair(kConfig, kLogin));
}

// With nowhere to open the provider's page, the request goes on as if the
// user closed it.
TEST(IdentityDialogTest, AProvidersPageWithNowhereToOpenIsDismissed) {
  Asked asked;
  IdentityDialog dialog(std::make_unique<FakeAsker>(asked));
  std::optional<DismissReason> dismissed;
  EXPECT_EQ(
      dialog.ShowModalDialog(
          kLogin, blink::mojom::RpMode::kPassive,
          base::BindOnce([](std::optional<DismissReason>* dismissed,
                            DismissReason reason) { *dismissed = reason; },
                         &dismissed),
          base::DoNothing(), base::DoNothing()),
      nullptr);
  EXPECT_EQ(dismissed, DismissReason::kOther);
}

// A page outside any <webview> has no shell to ask.
TEST(IdentityDialogTest, WithNoShellEveryStepIsRefused) {
  IdentityDialog dialog(nullptr);
  Told told;
  EXPECT_FALSE(ShowAccounts(dialog, told));
  EXPECT_EQ(told.dismissed, DismissReason::kOther);
}

}  // namespace
}  // namespace domicile
