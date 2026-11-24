// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_extension_popup_event.h"

#include "third_party/blink/renderer/bindings/modules/v8/v8_domicile_extension_popup_event_init.h"

namespace blink {

// static
DomicileExtensionPopupEvent* DomicileExtensionPopupEvent::Create(
    const AtomicString& type,
    const DomicileExtensionPopupEventInit* initializer) {
  return MakeGarbageCollected<DomicileExtensionPopupEvent>(type, initializer);
}

DomicileExtensionPopupEvent::DomicileExtensionPopupEvent(
    const AtomicString& type,
    const DomicileExtensionPopupEventInit* initializer)
    : Event(type, initializer),
      extension_id_(initializer->extensionId()),
      popup_(initializer->popup()),
      profile_(initializer->profile()) {}

DomicileExtensionPopupEvent::DomicileExtensionPopupEvent(
    const AtomicString& type,
    const String& extension_id,
    const String& popup,
    const String& profile)
    : Event(type, Bubbles::kNo, Cancelable::kNo),
      extension_id_(extension_id),
      popup_(popup),
      profile_(profile) {}

DomicileExtensionPopupEvent::~DomicileExtensionPopupEvent() = default;

const AtomicString& DomicileExtensionPopupEvent::InterfaceName() const {
  return event_interface_names::kDomicileExtensionPopupEvent;
}

void DomicileExtensionPopupEvent::Trace(Visitor* visitor) const {
  Event::Trace(visitor);
}

}  // namespace blink
