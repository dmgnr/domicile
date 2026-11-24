// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EXTENSION_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EXTENSION_H_

#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

// One extension with an action, as the browser described it.
//
// A ScriptWrappable because WebIDL does not allow a dictionary as an
// attribute's array element type. Immutable: the browser resends the whole
// tray on any change.
class MODULES_EXPORT DomicileExtension final : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  // `popup` is a null String for an action with no popup, so the IDL's
  // `USVString?` reads null.
  DomicileExtension(const String& id,
                    const String& name,
                    const String& title,
                    const String& icon,
                    const String& badge_text,
                    const String& badge_color,
                    const String& popup,
                    bool enabled,
                    const String& profile);
  ~DomicileExtension() override;

  const String& id() const { return id_; }
  const String& name() const { return name_; }
  const String& title() const { return title_; }
  const String& icon() const { return icon_; }
  const String& badgeText() const { return badge_text_; }
  const String& badgeColor() const { return badge_color_; }
  const String& popup() const { return popup_; }
  bool enabled() const { return enabled_; }
  const String& profile() const { return profile_; }

  void Trace(Visitor*) const override;

 private:
  String id_;
  String name_;
  String title_;
  String icon_;
  String badge_text_;
  String badge_color_;
  String popup_;
  bool enabled_ = false;
  String profile_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_EXTENSION_H_
