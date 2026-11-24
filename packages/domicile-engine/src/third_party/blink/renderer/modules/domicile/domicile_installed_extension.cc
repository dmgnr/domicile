// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_installed_extension.h"

#include "components/domicile/mojom/extension_tray.mojom-blink.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace blink {

namespace {

// The IDL's spelling of `access`, which is configureExtension()'s too.
String SiteAccessName(domicile::mojom::blink::SiteAccess access) {
  switch (access) {
    case domicile::mojom::blink::SiteAccess::kOnClick:
      return "on_click";
    case domicile::mojom::blink::SiteAccess::kSpecificSites:
      return "specific_sites";
    case domicile::mojom::blink::SiteAccess::kAllSites:
      return "all_sites";
  }
}

// The names of the settings `settings` sets.
Vector<String> SetNames(const domicile::mojom::blink::ExtensionSettings& set) {
  Vector<String> names;
  if (set.file_access.has_value()) {
    names.push_back("fileAccess");
  }
  if (set.user_scripts.has_value()) {
    names.push_back("userScripts");
  }
  if (set.site_access.has_value()) {
    names.push_back("siteAccess");
  }
  return names;
}

}  // namespace

DomicileInstalledExtension::DomicileInstalledExtension(
    const domicile::mojom::blink::InstalledExtension& extension)
    : id_(extension.id),
      name_(extension.name),
      icon_(extension.icon),
      enabled_(extension.enabled),
      file_access_(extension.settings->file_access),
      user_scripts_(extension.settings->user_scripts),
      site_access_(extension.settings->site_access.has_value()
                       ? SiteAccessName(*extension.settings->site_access)
                       : String()),
      sites_(MakeGarbageCollected<FrozenArray<IDLString>>(
          Vector<String>(extension.settings->sites))),
      configured_(MakeGarbageCollected<FrozenArray<IDLString>>(
          SetNames(*extension.config_settings))),
      from_config_(extension.from_config),
      options_url_(extension.options_url.empty() ? String()
                                                 : extension.options_url) {}

DomicileInstalledExtension::~DomicileInstalledExtension() = default;

void DomicileInstalledExtension::Trace(Visitor* visitor) const {
  visitor->Trace(sites_);
  visitor->Trace(configured_);
  ScriptWrappable::Trace(visitor);
}

}  // namespace blink
