// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_DOMICILE_IDENTITY_EVENT_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_DOMICILE_IDENTITY_EVENT_H_

#include <cstdint>

#include "components/domicile/mojom/web_view_guest.mojom-blink.h"
#include "third_party/blink/renderer/core/core_export.h"
#include "third_party/blink/renderer/core/dom/events/event.h"
#include "third_party/blink/renderer/platform/heap/collection_support/heap_vector.h"
#include "third_party/blink/renderer/platform/heap/member.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

class DomicileIdentityAccount;
class DomicileIdentityProvider;
class ExceptionState;
class HTMLWebViewElement;

// Asks the shell to show a step of a site's "Sign in with" (FedCM) request,
// for the page inside a <webview>.
//
// - Carries the browser's reply callback, as DomicilePromptEvent does. The
//   browser expects one answer, so a second throws InvalidStateError.
// - A shell claims it with `preventDefault()`. The element answers an
//   unclaimed one after dispatch as unanswered, so a shell that does not
//   listen leaves the site's request to fail as if dismissed.
// - The element holds it until answered, withdrawn or replaced by the next
//   step. Garbage collection would otherwise drop the callback unrun.
class CORE_EXPORT DomicileIdentityEvent final : public Event {
  DEFINE_WRAPPERTYPEINFO();

 public:
  using Answer =
      domicile::mojom::blink::WebViewGuestClient::IdentityRequestedCallback;

  DomicileIdentityEvent(
      const AtomicString& type,
      domicile::mojom::blink::WebViewIdentityRequestPtr request,
      Answer answer,
      HTMLWebViewElement& owner);
  ~DomicileIdentityEvent() override;

  String step() const;
  bool button() const { return request_->button; }
  const String& site() const { return request_->site; }
  const String& frameSite() const { return request_->frame_site; }
  String purpose() const;
  HeapVector<Member<DomicileIdentityProvider>> providers() const;
  HeapVector<Member<DomicileIdentityAccount>> accounts() const;
  bool automatic() const { return request_->automatic; }
  const String& error() const { return request_->error; }
  String errorUrl() const;

  void choose(int32_t account, ExceptionState&);
  void signInToProvider(int32_t provider, ExceptionState&);
  void moreDetails(ExceptionState&);
  void dismiss(ExceptionState&);

  // Called by the element for an unclaimed event, a withdrawn one and one the
  // next step replaced. Answers that it was not answered.
  void NoneIfUnanswered();

  const AtomicString& InterfaceName() const override;

  void Trace(Visitor*) const override;

 private:
  // False, and throws InvalidStateError, once answered or withdrawn.
  bool Answerable(ExceptionState&);
  void Run(domicile::mojom::blink::WebViewIdentityAction action, int32_t index);

  domicile::mojom::blink::WebViewIdentityRequestPtr request_;
  // Null once answered.
  Answer answer_;
  // Notified on answer so it releases this event.
  Member<HTMLWebViewElement> owner_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_DOMICILE_IDENTITY_EVENT_H_
