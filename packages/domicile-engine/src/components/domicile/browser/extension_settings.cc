// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/extension_settings.h"

#include <algorithm>
#include <utility>
#include <vector>

#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"

namespace domicile {
namespace {

constexpr char kInPrivate[] = "private";
constexpr char kFileAccess[] = "file_access";
constexpr char kUserScripts[] = "user_scripts";
constexpr char kSiteAccess[] = "site_access";
constexpr char kOnClick[] = "on_click";
constexpr char kAllSites[] = "all_sites";

// Reads `key` as a switch into `into`. False if it is there and not a
// boolean.
bool ReadSwitch(const base::DictValue& settings,
                const char* key,
                std::optional<bool>& into) {
  const base::Value* value = settings.Find(key);
  if (value == nullptr) {
    return true;
  }
  if (!value->is_bool()) {
    return false;
  }
  into = value->GetBool();
  return true;
}

// Reads `site_access` into `into`. False if it is there and not a mode or a
// list of sites.
bool ReadSiteAccess(const base::DictValue& settings, ExtensionSettings& into) {
  const base::Value* value = settings.Find(kSiteAccess);
  if (value == nullptr) {
    return true;
  }
  if (value->is_string()) {
    if (value->GetString() == kOnClick) {
      into.site_access = SiteAccess::kOnClick;
      return true;
    }
    if (value->GetString() == kAllSites) {
      into.site_access = SiteAccess::kAllSites;
      return true;
    }
    return false;
  }
  if (!value->is_list()) {
    return false;
  }
  into.site_access = SiteAccess::kSpecificSites;
  for (const base::Value& site : value->GetList()) {
    if (!site.is_string() || !SitePattern(site.GetString())) {
      return false;
    }
    into.sites.push_back(base::ToLowerASCII(site.GetString()));
  }
  return true;
}

// Whether `label` is letters, digits and hyphens, not at either end.
bool IsLabel(std::string_view label) {
  return !label.empty() && label.size() <= 63 && label.front() != '-' &&
         label.back() != '-' && std::ranges::all_of(label, [](char c) {
           return base::IsAsciiAlphaNumeric(c) || c == '-';
         });
}

// Whether `label` is a hex number, `0x` and hex digits.
bool IsHex(std::string_view label) {
  return label.size() >= 2 && label[0] == '0' &&
         base::ToLowerASCII(label[1]) == 'x' &&
         std::ranges::all_of(label.substr(2), base::IsHexDigit<char>);
}

// Whether `host` is labels, the last with a letter and not a hex number: a
// name rather than a number, which URLPattern would read as an IP address.
bool IsHostName(std::string_view host) {
  const std::vector<std::string_view> labels = base::SplitStringPiece(
      host, ".", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
  return !labels.empty() && std::ranges::all_of(labels, IsLabel) &&
         std::ranges::any_of(labels.back(), base::IsAsciiAlpha<char>) &&
         !IsHex(labels.back());
}

// Whether `host` is four dot-separated numbers from 0 to 255, with no leading
// zero, which a URL reads as octal.
bool IsIPv4(std::string_view host) {
  const std::vector<std::string_view> parts = base::SplitStringPiece(
      host, ".", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
  return parts.size() == 4 && std::ranges::all_of(parts, [](auto part) {
           unsigned value = 0;
           return !part.empty() && part.size() <= 3 &&
                  (part.size() == 1 || part.front() != '0') &&
                  std::ranges::all_of(part, base::IsAsciiDigit<char>) &&
                  base::StringToUint(part, &value) && value <= 255;
         });
}

void SetSwitch(base::DictValue& settings,
               const char* key,
               const std::optional<bool>& value) {
  if (value.has_value()) {
    settings.Set(key, *value);
  }
}

}  // namespace

ExtensionSettings::ExtensionSettings() = default;
ExtensionSettings::ExtensionSettings(const ExtensionSettings&) = default;
ExtensionSettings& ExtensionSettings::operator=(const ExtensionSettings&) =
    default;
ExtensionSettings::~ExtensionSettings() = default;

std::optional<ExtensionSettings> ParseOneExtensionSettings(
    const base::DictValue& settings) {
  for (const auto [key, value] : settings) {
    if (key != kInPrivate && key != kFileAccess && key != kUserScripts &&
        key != kSiteAccess) {
      return std::nullopt;
    }
  }
  ExtensionSettings read;
  if (!ReadSwitch(settings, kInPrivate, read.in_private) ||
      !ReadSwitch(settings, kFileAccess, read.file_access) ||
      !ReadSwitch(settings, kUserScripts, read.user_scripts) ||
      !ReadSiteAccess(settings, read)) {
    return std::nullopt;
  }
  return read;
}

std::optional<ExtensionSettingsMap> ParseExtensionSettings(
    const base::DictValue& settings) {
  ExtensionSettingsMap read;
  for (const auto [id, value] : settings) {
    if (!value.is_dict()) {
      return std::nullopt;
    }
    std::optional<ExtensionSettings> one =
        ParseOneExtensionSettings(value.GetDict());
    if (!one) {
      return std::nullopt;
    }
    read.emplace(id, *std::move(one));
  }
  return read;
}

base::DictValue OneExtensionSettingsValue(const ExtensionSettings& settings) {
  base::DictValue value;
  SetSwitch(value, kInPrivate, settings.in_private);
  SetSwitch(value, kFileAccess, settings.file_access);
  SetSwitch(value, kUserScripts, settings.user_scripts);
  if (settings.site_access.has_value()) {
    switch (*settings.site_access) {
      case SiteAccess::kOnClick:
        value.Set(kSiteAccess, kOnClick);
        break;
      case SiteAccess::kAllSites:
        value.Set(kSiteAccess, kAllSites);
        break;
      case SiteAccess::kSpecificSites: {
        base::ListValue sites;
        for (const std::string& site : settings.sites) {
          sites.Append(site);
        }
        value.Set(kSiteAccess, std::move(sites));
        break;
      }
    }
  }
  return value;
}

base::DictValue ExtensionSettingsValue(const ExtensionSettingsMap& settings) {
  base::DictValue value;
  for (const auto& [id, one] : settings) {
    value.Set(id, OneExtensionSettingsValue(one));
  }
  return value;
}

std::optional<std::string> SitePattern(std::string_view site) {
  const bool subdomains = base::StartsWith(site, "*.");
  const std::string_view host = subdomains ? site.substr(2) : site;
  const bool named = IsHostName(host);
  if (!named && (subdomains || !IsIPv4(host))) {
    return std::nullopt;
  }
  return base::StrCat({"*://", base::ToLowerASCII(site), "/*"});
}

ExtensionSettingsMap ReconcileSettings(const ExtensionSettingsMap& wanted,
                                       const ExtensionSettingsMap& previous) {
  ExtensionSettingsMap changes = wanted;
  for (const auto& [id, before] : previous) {
    ExtensionSettings& now = changes[id];
    if (before.in_private.has_value() && !now.in_private.has_value()) {
      now.in_private = false;
    }
    if (before.file_access.has_value() && !now.file_access.has_value()) {
      now.file_access = false;
    }
    if (before.user_scripts.has_value() && !now.user_scripts.has_value()) {
      now.user_scripts = false;
    }
    if (before.site_access.has_value() && !now.site_access.has_value()) {
      now.site_access = SiteAccess::kAllSites;
    }
  }
  return changes;
}

std::optional<std::string> SetByConfig(const ExtensionSettings& wanted,
                                       const ExtensionSettings& configured) {
  if (wanted.in_private.has_value() && configured.in_private.has_value()) {
    return "private";
  }
  if (wanted.file_access.has_value() && configured.file_access.has_value()) {
    return "file_access";
  }
  if (wanted.user_scripts.has_value() && configured.user_scripts.has_value()) {
    return "user_scripts";
  }
  if (wanted.site_access.has_value() && configured.site_access.has_value()) {
    return "site_access";
  }
  return std::nullopt;
}

}  // namespace domicile
