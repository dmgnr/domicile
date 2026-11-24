// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_EXTENSION_SETTINGS_H_
#define COMPONENTS_DOMICILE_BROWSER_EXTENSION_SETTINGS_H_

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/values.h"

namespace domicile {

// Where an extension runs on the sites it asks for, as chrome://extensions'
// "Site access" offers.
enum class SiteAccess {
  // Only on a site where its action was clicked (activeTab).
  kOnClick,
  // Only on `ExtensionSettings::sites`.
  kSpecificSites,
  // Everywhere it asks to.
  kAllSites,
};

// The settings chrome://extensions has for each extension. Each is unset
// where it is not being set, or where the extension cannot use it.
struct ExtensionSettings {
  ExtensionSettings();
  ExtensionSettings(const ExtensionSettings&);
  ExtensionSettings& operator=(const ExtensionSettings&);
  ~ExtensionSettings();
  friend bool operator==(const ExtensionSettings&,
                         const ExtensionSettings&) = default;

  // Runs in private windows.
  std::optional<bool> in_private;
  // Runs on file:// pages.
  std::optional<bool> file_access;
  // May use chrome.userScripts.
  std::optional<bool> user_scripts;
  std::optional<SiteAccess> site_access;
  // With kSpecificSites: hosts, each also as `*.host` for its subdomains.
  std::vector<std::string> sites;
};

// Settings by extension id.
using ExtensionSettingsMap = std::map<std::string, ExtensionSettings>;

// Reads settings by id as the config spells them:
//
//   {"<id>": {"private": true, "file_access": true, "user_scripts": true,
//             "site_access": "on_click" | "all_sites" | ["github.com", ...]}}
//
// Every key is optional. Nothing for anything else, so a bad list changes
// nothing.
std::optional<ExtensionSettingsMap> ParseExtensionSettings(
    const base::DictValue& settings);

// One extension's settings, as ParseExtensionSettings reads each.
std::optional<ExtensionSettings> ParseOneExtensionSettings(
    const base::DictValue& settings);

// Spells `settings` as ParseExtensionSettings reads them.
base::DictValue ExtensionSettingsValue(const ExtensionSettingsMap& settings);
base::DictValue OneExtensionSettingsValue(const ExtensionSettings& settings);

// The pattern Chrome grants for a site a user names: `*://<host>/*`, so both
// http and https. `site` is a host or `*.host`; nothing for anything else.
//
// A host is dot-separated labels of letters, digits and inner hyphens, the
// last with a letter and not a hex number such as `0x1f`, or a dotted IPv4
// address (without `*.`). The config
// and the Settings app check the same rule.
std::optional<std::string> SitePattern(std::string_view site);

// What to set so a profile holds `wanted`, the config's settings, when it
// held `previous`: every setting in `wanted`, plus Chrome's default for each
// one `previous` named and `wanted` no longer does. A setting the config
// never named is the user's, from the Settings app, and is left alone.
ExtensionSettingsMap ReconcileSettings(const ExtensionSettingsMap& wanted,
                                       const ExtensionSettingsMap& previous);

// The first setting `wanted` sets that `configured`, the config's, also sets,
// as the config spells its key; nothing if none. Only the config changes
// what it sets.
std::optional<std::string> SetByConfig(const ExtensionSettings& wanted,
                                       const ExtensionSettings& configured);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_EXTENSION_SETTINGS_H_
