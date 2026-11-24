// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_extension.h"

namespace blink {

DomicileExtension::DomicileExtension(const String& id,
                                     const String& name,
                                     const String& title,
                                     const String& icon,
                                     const String& badge_text,
                                     const String& badge_color,
                                     const String& popup,
                                     bool enabled,
                                     const String& profile)
    : id_(id),
      name_(name),
      title_(title),
      icon_(icon),
      badge_text_(badge_text),
      badge_color_(badge_color),
      popup_(popup),
      enabled_(enabled),
      profile_(profile) {}

DomicileExtension::~DomicileExtension() = default;

void DomicileExtension::Trace(Visitor* visitor) const {
  ScriptWrappable::Trace(visitor);
}

}  // namespace blink
