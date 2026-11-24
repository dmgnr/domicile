// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_BROWSER_PROFILE_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_BROWSER_PROFILE_H_

#include "third_party/blink/renderer/bindings/core/v8/frozen_array.h"
#include "third_party/blink/renderer/bindings/core/v8/idl_types.h"
#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/heap/member.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace blink {

class MODULES_EXPORT DomicileBrowserProfile final : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  DomicileBrowserProfile(const String& id,
                         const String& name,
                         const String& color,
                         bool is_private,
                         bool is_default,
                         bool is_default_private,
                         const Vector<String>& pinned_sites,
                         const Vector<String>& config_sites,
                         const Vector<String>& extensions,
                         const Vector<String>& enabled_extensions,
                         const Vector<String>& locked_extensions);
  ~DomicileBrowserProfile() override;

  const String& id() const { return id_; }
  const String& name() const { return name_; }
  const String& color() const { return color_; }
  bool isPrivate() const { return is_private_; }
  bool isDefault() const { return is_default_; }
  bool isDefaultPrivate() const { return is_default_private_; }
  const FrozenArray<IDLString>& pinnedSites() const { return *pinned_sites_; }
  const FrozenArray<IDLString>& configSites() const { return *config_sites_; }
  const FrozenArray<IDLString>& extensions() const { return *extensions_; }
  const FrozenArray<IDLString>& enabledExtensions() const {
    return *enabled_extensions_;
  }
  const FrozenArray<IDLString>& lockedExtensions() const {
    return *locked_extensions_;
  }

  void Trace(Visitor*) const override;

 private:
  String id_;
  String name_;
  String color_;
  bool is_private_;
  bool is_default_;
  bool is_default_private_;
  Member<FrozenArray<IDLString>> pinned_sites_;
  Member<FrozenArray<IDLString>> config_sites_;
  Member<FrozenArray<IDLString>> extensions_;
  Member<FrozenArray<IDLString>> enabled_extensions_;
  Member<FrozenArray<IDLString>> locked_extensions_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_BROWSER_PROFILE_H_
