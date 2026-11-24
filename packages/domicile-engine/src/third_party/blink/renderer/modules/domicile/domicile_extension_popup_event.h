// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EXTENSION_POPUP_EVENT_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EXTENSION_POPUP_EVENT_H_

#include "third_party/blink/renderer/modules/event_modules.h"
#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

class DomicileExtensionPopupEventInit;

// An extension asked for its popup with `action.openPopup()`:
// `extensionpopuprequested`. The shell opens `popup` as it opens a clicked
// action's.
class MODULES_EXPORT DomicileExtensionPopupEvent final : public Event {
  DEFINE_WRAPPERTYPEINFO();

 public:
  static DomicileExtensionPopupEvent* Create(
      const AtomicString& type,
      const DomicileExtensionPopupEventInit* initializer);

  DomicileExtensionPopupEvent(
      const AtomicString& type,
      const DomicileExtensionPopupEventInit* initializer);
  DomicileExtensionPopupEvent(const AtomicString& type,
                              const String& extension_id,
                              const String& popup,
                              const String& profile);
  ~DomicileExtensionPopupEvent() override;

  const String& extensionId() const { return extension_id_; }
  const String& popup() const { return popup_; }
  const String& profile() const { return profile_; }

  const AtomicString& InterfaceName() const override;
  void Trace(Visitor*) const override;

 private:
  String extension_id_;
  String popup_;
  String profile_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EXTENSION_POPUP_EVENT_H_
