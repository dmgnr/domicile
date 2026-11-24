// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/browser_profiles.h"

#include <algorithm>
#include <set>
#include <tuple>
#include <utility>

#include "url/gurl.h"

namespace domicile {
namespace {

bool IsProfileId(std::string_view id) {
  return !id.empty() && std::ranges::all_of(id, [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
  });
}

// A list of strings, or nothing when `value` is anything else.
std::optional<std::vector<std::string>> Strings(const base::ListValue& value) {
  std::vector<std::string> strings;
  for (const base::Value& item : value) {
    if (!item.is_string()) {
      return std::nullopt;
    }
    strings.push_back(item.GetString());
  }
  return strings;
}

std::optional<BrowserProfile> ParseProfile(const base::Value& value) {
  const base::DictValue* dict = value.GetIfDict();
  if (dict == nullptr) {
    return std::nullopt;
  }
  const std::string* id = dict->FindString("id");
  const std::string* name = dict->FindString("name");
  const std::string* color = dict->FindString("color");
  const std::optional<bool> is_private = dict->FindBool("private");
  if (id == nullptr || !IsProfileId(*id) || name == nullptr ||
      color == nullptr || !is_private.has_value()) {
    return std::nullopt;
  }
  BrowserProfile profile{
      .id = *id, .name = *name, .color = *color, .is_private = *is_private};
  const base::Value* extensions = dict->Find("extensions");
  if (extensions != nullptr && !extensions->is_none()) {
    if (!extensions->is_list()) {
      return std::nullopt;
    }
    profile.extensions = Strings(extensions->GetList());
    if (!profile.extensions.has_value()) {
      return std::nullopt;
    }
  }
  return profile;
}

// Whether `profiles` agrees with itself, as the config checks.
bool Consistent(const BrowserProfiles& profiles) {
  std::set<std::string> ids;
  for (const BrowserProfile& profile : profiles.profiles) {
    if (!ids.insert(profile.id).second) {
      return false;
    }
  }
  const BrowserProfile* fallback = profiles.Find(profiles.default_profile);
  const BrowserProfile* fallback_private =
      profiles.Find(profiles.default_private_profile);
  return fallback != nullptr && !fallback->is_private &&
         fallback_private != nullptr && fallback_private->is_private &&
         std::ranges::all_of(profiles.sites, [&profiles](const auto& site) {
           return profiles.Find(site.second) != nullptr &&
                  site.second != profiles.default_profile;
         });
}

// How specifically `site` matches `url`, or nothing when it does not. Higher
// is more specific: path segments, then an exact host, then host length.
std::optional<std::tuple<size_t, bool, size_t>> SiteMatch(
    std::string_view site,
    const GURL& url) {
  std::string_view host = site;
  std::string_view path;
  if (const size_t slash = site.find('/'); slash != std::string_view::npos) {
    host = site.substr(0, slash);
    path = site.substr(slash);
  }
  const std::string_view url_host = url.host();
  const bool wildcard = host.starts_with("*.");
  if (wildcard) {
    const std::string_view parent = host.substr(2);
    if (url_host != parent &&
        !(url_host.ends_with(parent) &&
          url_host[url_host.size() - parent.size() - 1] == '.')) {
      return std::nullopt;
    }
  } else if (url_host != host) {
    return std::nullopt;
  }
  if (!path.empty()) {
    const std::string_view url_path = url.path();
    if (!(url_path == path ||
          (url_path.starts_with(path) && url_path[path.size()] == '/'))) {
      return std::nullopt;
    }
  }
  return std::tuple(static_cast<size_t>(std::ranges::count(path, '/')),
                    !wildcard, host.size());
}

}  // namespace

BrowserProfiles::BrowserProfiles() = default;
BrowserProfiles::BrowserProfiles(const BrowserProfiles&) = default;
BrowserProfiles& BrowserProfiles::operator=(const BrowserProfiles&) = default;
BrowserProfiles::~BrowserProfiles() = default;

const BrowserProfile* BrowserProfiles::Find(std::string_view id) const {
  auto found = std::ranges::find(profiles, id, &BrowserProfile::id);
  return found == profiles.end() ? nullptr : &*found;
}

BrowserProfiles DefaultBrowserProfiles() {
  BrowserProfiles profiles;
  profiles.profiles = {
      BrowserProfile{.id = "default", .name = "Default", .color = "#0d9488"},
      BrowserProfile{.id = "private",
                     .name = "Private",
                     .color = "#a78bfa",
                     .is_private = true},
  };
  profiles.default_profile = "default";
  profiles.default_private_profile = "private";
  return profiles;
}

std::optional<BrowserProfiles> ParseBrowserProfiles(
    const base::DictValue& message) {
  const base::ListValue* list = message.FindList("profiles");
  const std::string* fallback = message.FindString("default_profile");
  const std::string* fallback_private =
      message.FindString("default_private_profile");
  const base::DictValue* sites = message.FindDict("sites");
  if (list == nullptr || fallback == nullptr || fallback_private == nullptr ||
      sites == nullptr) {
    return std::nullopt;
  }
  BrowserProfiles profiles;
  for (const base::Value& item : *list) {
    std::optional<BrowserProfile> profile = ParseProfile(item);
    if (!profile.has_value()) {
      return std::nullopt;
    }
    profiles.profiles.push_back(std::move(*profile));
  }
  for (const auto [site, id] : *sites) {
    if (!id.is_string()) {
      return std::nullopt;
    }
    profiles.sites[site] = id.GetString();
  }
  profiles.default_profile = *fallback;
  profiles.default_private_profile = *fallback_private;
  if (!Consistent(profiles)) {
    return std::nullopt;
  }
  return profiles;
}

BrowserProfiles WithPinnedSites(const BrowserProfiles& config,
                                const PinnedSites& pinned) {
  BrowserProfiles profiles = config;
  for (const auto& [site, profile] : pinned) {
    if (profile != config.default_profile && config.Find(profile) != nullptr) {
      // emplace leaves the config's own entry for the site.
      profiles.sites.emplace(site, profile);
    }
  }
  return profiles;
}

bool IsSiteKey(std::string_view site) {
  std::string_view host = site;
  if (const size_t slash = site.find('/'); slash != std::string_view::npos) {
    host = site.substr(0, slash);
    const std::string_view path = site.substr(slash);
    if (path.size() < 2 || path.ends_with('/') ||
        path.find_first_of("?#") != std::string_view::npos) {
      return false;
    }
  }
  if (host.starts_with("*.")) {
    host.remove_prefix(2);
  }
  return !host.empty() && !host.starts_with('.') && !host.ends_with('.') &&
         std::ranges::all_of(host, [](char c) {
           return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                  c == '-' || c == '.';
         });
}

const std::string* SiteForUrl(const BrowserProfiles& profiles,
                              const GURL& url) {
  if (!url.SchemeIsHTTPOrHTTPS()) {
    return nullptr;
  }
  const std::string* best = nullptr;
  std::optional<std::tuple<size_t, bool, size_t>> best_match;
  for (const auto& entry : profiles.sites) {
    const auto match = SiteMatch(entry.first, url);
    if (match.has_value() && (!best_match.has_value() || *match > *best_match)) {
      best = &entry.first;
      best_match = match;
    }
  }
  return best;
}

const std::string& ProfileForUrl(const BrowserProfiles& profiles,
                                 const GURL& url) {
  const std::string* site = SiteForUrl(profiles, url);
  return site == nullptr ? profiles.default_profile : profiles.sites.at(*site);
}

const std::string& ProfileForNewWindow(const BrowserProfiles& profiles,
                                       const std::string& asker,
                                       const GURL& url) {
  return url.SchemeIsHTTPOrHTTPS() ? ProfileForUrl(profiles, url) : asker;
}

std::optional<std::string> RouteNavigation(const BrowserProfiles& profiles,
                                           const std::string& page_profile,
                                           const GURL& from,
                                           const GURL& to) {
  if (!to.SchemeIsHTTPOrHTTPS()) {
    return std::nullopt;
  }
  const std::string& target = ProfileForUrl(profiles, to);
  if (target == ProfileForUrl(profiles, from) || target == page_profile) {
    return std::nullopt;
  }
  return target;
}

bool IsUserNavigation(bool main_frame,
                      bool same_document,
                      bool renderer_initiated,
                      bool user_gesture,
                      bool post,
                      ui::PageTransition transition) {
  if (!main_frame || same_document || post ||
      ui::PageTransitionCoreTypeIs(transition, ui::PAGE_TRANSITION_RELOAD)) {
    return false;
  }
  return (transition & ui::PAGE_TRANSITION_FORWARD_BACK) ||
         !renderer_initiated || user_gesture;
}

ExtensionList ExtensionsFor(
    const BrowserProfile& profile,
    const ExtensionList& all,
    base::FunctionRef<std::string(const std::string&)> unpacked_id) {
  ExtensionList chosen = all;
  // A private profile's pages are off the record, where an extension runs
  // only when allowed to. Its switch is that permission: one switched off
  // runs nowhere.
  if (profile.is_private) {
    for (const std::string& id : all.web_store) {
      chosen.settings[id].in_private = true;
    }
    for (const std::string& directory : all.unpacked) {
      chosen.settings[unpacked_id(directory)].in_private = true;
    }
  }
  return chosen;
}

std::vector<UserExtension> UserExtensionsMissing(
    const std::vector<std::vector<UserExtension>>& each,
    const std::set<std::string>& installed,
    const std::set<std::string>& config_ids) {
  std::vector<UserExtension> missing;
  std::set<std::string> seen;
  for (const std::vector<UserExtension>& profile : each) {
    for (const UserExtension& extension : profile) {
      if (installed.contains(extension.id) ||
          config_ids.contains(extension.id) ||
          !seen.insert(extension.id).second) {
        continue;
      }
      missing.push_back(extension);
    }
  }
  return missing;
}

std::optional<bool> ConfigSwitch(const BrowserProfile& profile,
                                 std::string_view id) {
  if (!profile.extensions.has_value()) {
    return std::nullopt;
  }
  return std::ranges::contains(*profile.extensions, id);
}

bool DefaultSwitch(const BrowserProfile& profile) {
  return !profile.is_private;
}

}  // namespace domicile
