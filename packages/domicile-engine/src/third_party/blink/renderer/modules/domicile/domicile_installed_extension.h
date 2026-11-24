// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_INSTALLED_EXTENSION_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_INSTALLED_EXTENSION_H_

#include <optional>

#include "components/domicile/mojom/extension_tray.mojom-blink-forward.h"
#include "third_party/blink/renderer/bindings/core/v8/frozen_array.h"
#include "third_party/blink/renderer/bindings/core/v8/idl_types.h"
#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/heap/member.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

// One installed extension, as the browser described it. Immutable: the
// browser resends every extension on any change.
class MODULES_EXPORT DomicileInstalledExtension final : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  explicit DomicileInstalledExtension(
      const domicile::mojom::blink::InstalledExtension& extension);
  ~DomicileInstalledExtension() override;

  const String& id() const { return id_; }
  const String& name() const { return name_; }
  const String& icon() const { return icon_; }
  bool enabled() const { return enabled_; }
  std::optional<bool> fileAccess() const { return file_access_; }
  std::optional<bool> userScripts() const { return user_scripts_; }
  // A null String where the extension asks for no sites, so the IDL's
  // `DOMString?` reads null.
  const String& siteAccess() const { return site_access_; }
  const FrozenArray<IDLString>& sites() const { return *sites_; }
  const FrozenArray<IDLString>& configured() const { return *configured_; }
  bool fromConfig() const { return from_config_; }
  // A null String where there is no options page.
  const String& optionsUrl() const { return options_url_; }

  void Trace(Visitor*) const override;

 private:
  String id_;
  String name_;
  String icon_;
  bool enabled_ = false;
  std::optional<bool> file_access_;
  std::optional<bool> user_scripts_;
  String site_access_;
  Member<FrozenArray<IDLString>> sites_;
  Member<FrozenArray<IDLString>> configured_;
  bool from_config_ = false;
  String options_url_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_INSTALLED_EXTENSION_H_
