// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/core/html/domicile/domicile_identity_event.h"

#include <utility>

#include "base/notreached.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_domicile_identity_account.h"
#include "third_party/blink/renderer/bindings/core/v8/v8_domicile_identity_provider.h"
#include "third_party/blink/renderer/core/event_interface_names.h"
#include "third_party/blink/renderer/core/html/domicile/html_web_view_element.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"
#include "third_party/blink/renderer/platform/weborigin/kurl.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace blink {

namespace {

using Action = domicile::mojom::blink::WebViewIdentityAction;
using Field = domicile::mojom::blink::WebViewIdentityField;
using Purpose = domicile::mojom::blink::WebViewIdentityPurpose;
using Step = domicile::mojom::blink::WebViewIdentityStep;

constexpr char kAnswered[] =
    "This sign-in step has already been answered or withdrawn.";

// A URL as the shell reads it: "" for none.
String TextOf(const KURL& url) {
  return url.IsValid() ? url.GetString() : g_empty_string;
}

// The fields' names in an account's `shared`. See
// domicile_identity_account.idl.
String NameOf(Field field) {
  switch (field) {
    case Field::kName:
      return "name";
    case Field::kEmail:
      return "email";
    case Field::kUsername:
      return "username";
    case Field::kPhoneNumber:
      return "phone-number";
    case Field::kPicture:
      return "picture";
  }
  NOTREACHED();
}

}  // namespace

// Bubbles like the element's other events. Cancelable because
// `preventDefault()` claims the request (see the header).
DomicileIdentityEvent::DomicileIdentityEvent(
    const AtomicString& type,
    domicile::mojom::blink::WebViewIdentityRequestPtr request,
    Answer answer,
    HTMLWebViewElement& owner)
    : Event(type, Bubbles::kYes, Cancelable::kYes),
      request_(std::move(request)),
      answer_(std::move(answer)),
      owner_(&owner) {}

DomicileIdentityEvent::~DomicileIdentityEvent() = default;

// The steps' names in `step`. See domicile_identity_event.idl.
String DomicileIdentityEvent::step() const {
  switch (request_->step) {
    case Step::kLoading:
      return "loading";
    case Step::kAccounts:
      return "accounts";
    case Step::kSignedOut:
      return "signed-out";
    case Step::kVerifying:
      return "verifying";
    case Step::kError:
      return "error";
  }
  NOTREACHED();
}

String DomicileIdentityEvent::purpose() const {
  switch (request_->purpose) {
    case Purpose::kSignIn:
      return "sign-in";
    case Purpose::kSignUp:
      return "sign-up";
    case Purpose::kUse:
      return "use";
    case Purpose::kContinue:
      return "continue";
  }
  NOTREACHED();
}

HeapVector<Member<DomicileIdentityProvider>> DomicileIdentityEvent::providers()
    const {
  HeapVector<Member<DomicileIdentityProvider>> providers;
  for (const auto& offered : request_->providers) {
    auto* provider = DomicileIdentityProvider::Create();
    provider->setName(offered->name);
    provider->setIcon(offered->icon);
    provider->setPrivacyPolicy(TextOf(offered->privacy_policy));
    provider->setTermsOfService(TextOf(offered->terms_of_service));
    provider->setSignedOut(offered->signed_out);
    provider->setAddAccount(offered->add_account);
    providers.push_back(provider);
  }
  return providers;
}

HeapVector<Member<DomicileIdentityAccount>> DomicileIdentityEvent::accounts()
    const {
  HeapVector<Member<DomicileIdentityAccount>> accounts;
  for (const auto& offered : request_->accounts) {
    auto* account = DomicileIdentityAccount::Create();
    account->setProvider(offered->provider);
    account->setName(offered->name);
    account->setIdentifier(offered->identifier);
    account->setPicture(offered->picture);
    account->setReturning(offered->returning);
    Vector<String> shared;
    for (const Field field : offered->shared) {
      shared.push_back(NameOf(field));
    }
    account->setShared(std::move(shared));
    accounts.push_back(account);
  }
  return accounts;
}

String DomicileIdentityEvent::errorUrl() const {
  return TextOf(request_->error_url);
}

void DomicileIdentityEvent::choose(int32_t account,
                                   ExceptionState& exception_state) {
  if (!Answerable(exception_state)) {
    return;
  }
  if (request_->step != Step::kAccounts) {
    exception_state.ThrowDOMException(DOMExceptionCode::kInvalidStateError,
                                      "Only the accounts step takes one.");
    return;
  }
  if (account < 0 ||
      static_cast<wtf_size_t>(account) >= request_->accounts.size()) {
    exception_state.ThrowTypeError("No account with that index was offered.");
    return;
  }
  Run(Action::kChoose, account);
}

void DomicileIdentityEvent::signInToProvider(int32_t provider,
                                             ExceptionState& exception_state) {
  if (!Answerable(exception_state)) {
    return;
  }
  if (request_->step != Step::kAccounts && request_->step != Step::kSignedOut) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "Only the accounts and signed-out steps open a provider's sign-in.");
    return;
  }
  if (provider < 0 ||
      static_cast<wtf_size_t>(provider) >= request_->providers.size()) {
    exception_state.ThrowTypeError("No provider with that index was offered.");
    return;
  }
  Run(Action::kSignInToProvider, provider);
}

void DomicileIdentityEvent::moreDetails(ExceptionState& exception_state) {
  if (!Answerable(exception_state)) {
    return;
  }
  if (request_->step != Step::kError || !request_->error_url.IsValid()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "Only an error with a page about it has more details.");
    return;
  }
  Run(Action::kMoreDetails, 0);
}

void DomicileIdentityEvent::dismiss(ExceptionState& exception_state) {
  if (!Answerable(exception_state)) {
    return;
  }
  Run(Action::kDismiss, 0);
}

void DomicileIdentityEvent::NoneIfUnanswered() {
  if (answer_) {
    Run(Action::kNone, 0);
  }
}

bool DomicileIdentityEvent::Answerable(ExceptionState& exception_state) {
  if (!answer_) {
    exception_state.ThrowDOMException(DOMExceptionCode::kInvalidStateError,
                                      kAnswered);
    return false;
  }
  return true;
}

void DomicileIdentityEvent::Run(Action action, int32_t index) {
  std::move(answer_).Run(action, index);
  owner_->IdentityAnswered(*this);
  owner_ = nullptr;
}

const AtomicString& DomicileIdentityEvent::InterfaceName() const {
  return event_interface_names::kDomicileIdentityEvent;
}

void DomicileIdentityEvent::Trace(Visitor* visitor) const {
  visitor->Trace(owner_);
  Event::Trace(visitor);
}

}  // namespace blink
