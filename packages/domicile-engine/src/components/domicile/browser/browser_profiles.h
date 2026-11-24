// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_BROWSER_PROFILES_H_
#define COMPONENTS_DOMICILE_BROWSER_BROWSER_PROFILES_H_

#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/functional/function_ref.h"
#include "base/values.h"
#include "components/domicile/browser/extension_installer.h"
#include "ui/base/page_transition_types.h"

class GURL;

namespace domicile {

// One browser profile: a set of sign-ins, site data and extensions. See
// docs/architecture/BROWSER-PROFILES.md.
struct BrowserProfile {
  friend bool operator==(const BrowserProfile&,
                         const BrowserProfile&) = default;

  // Lowercase letters, digits and `-`, so it names a directory.
  std::string id;
  std::string name;
  // `#rrggbb`.
  std::string color;
  // Keeps nothing past its last page.
  bool is_private = false;
  // The extension ids it turns on; nothing turns on all of them, or none for
  // a private profile.
  std::optional<std::vector<std::string>> extensions;
};

// The desk's browser profiles: the config's `browser`, as the compositor's
// `browser_profiles` message carries it.
struct BrowserProfiles {
  BrowserProfiles();
  BrowserProfiles(const BrowserProfiles&);
  BrowserProfiles& operator=(const BrowserProfiles&);
  ~BrowserProfiles();
  friend bool operator==(const BrowserProfiles&,
                         const BrowserProfiles&) = default;

  // Profile `id`, or null.
  const BrowserProfile* Find(std::string_view id) const;

  std::vector<BrowserProfile> profiles;
  // Where an unlisted site opens. Never private.
  std::string default_profile;
  // Where a new private window opens. Always private.
  std::string default_private_profile;
  // Profile ids by site: a host, `*.host`, or a host and path.
  std::map<std::string, std::string> sites;
};

// The profiles of a desk whose compositor sends none: `default` and
// `private`, as the config's own defaults.
BrowserProfiles DefaultBrowserProfiles();

// Reads a `browser_profiles` message:
//
//   {"profiles": [{"id": "work", "name": "Work", "color": "#d97706",
//                  "private": false, "extensions": ["<id>", ...] | null}],
//    "default_profile": "personal", "default_private_profile": "private",
//    "sites": {"github.com/acme": "work"}}
//
// Nothing when malformed, or when it contradicts itself as the config refuses
// to: a default that is no profile or is private, a default private profile
// that is not private, a site in no profile or in the default one, an id that
// is no directory name, or two profiles with one id.
std::optional<BrowserProfiles> ParseBrowserProfiles(
    const base::DictValue& message);

// The sites the user pinned to a profile from a shell, by site, as the engine
// keeps them beside the config's own (WithPinnedSites).
using PinnedSites = std::map<std::string, std::string>;

// `config` with the user's `pinned` sites added to its own. The config wins:
// a pin of a site the config's sites name is left out. So is one to a profile
// the config does not have, or to its default profile, which a site never
// maps to. Pins stay kept while left out, so one comes back with its profile.
BrowserProfiles WithPinnedSites(const BrowserProfiles& config,
                                const PinnedSites& pinned);

// Whether `site` can be a key of `BrowserProfiles::sites`: a lowercase host,
// `*.` and a host, or a host and a path that starts with `/`.
bool IsSiteKey(std::string_view site);

// The key of `profiles.sites` that routes `url` (ProfileForUrl), or null when
// none matches and it opens in the default profile.
const std::string* SiteForUrl(const BrowserProfiles& profiles, const GURL& url);

// The profile `url` opens in: the most specific of `profiles.sites` that
// matches it, else the default profile. A host and path is more specific than
// a host, a host than `*.host`, and a longer one than a shorter. Only web
// addresses are in sites; any other opens in the default profile.
const std::string& ProfileForUrl(const BrowserProfiles& profiles,
                                 const GURL& url);

// The profile a new window at `url` opens in, asked for from profile
// `asker`: by its site (ProfileForUrl) for a web address, else `asker`'s own.
// An extension's page, such as one chrome.tabs.create opens, must open where
// the extension is switched on: in another profile it is off, and its page is
// blank.
const std::string& ProfileForNewWindow(const BrowserProfiles& profiles,
                                       const std::string& asker,
                                       const GURL& url);

// The profile a page in profile `page_profile` moves to as the user takes it
// from `from` to `to`, or nothing when it stays. It moves when routing puts
// the two addresses in different profiles and `to`'s is not the page's own:
// a page moved by hand stays where it was put while it stays on one site.
std::optional<std::string> RouteNavigation(const BrowserProfiles& profiles,
                                           const std::string& page_profile,
                                           const GURL& from,
                                           const GURL& to);

// Whether a window's navigation is one the user took, which may move its page
// to the profile of the site it goes to (RouteNavigation): a link they
// clicked, the address bar, the shell's own, or a step back or forward. In
// the main frame, to a new document. Not a reload, a POST, whose body would
// not survive the move, or the page's own script with no click behind it.
bool IsUserNavigation(bool main_frame,
                      bool same_document,
                      bool renderer_initiated,
                      bool user_gesture,
                      bool post,
                      ui::PageTransition transition);

// The extensions of `all` to install into `profile`'s Chrome profile, with
// every setting: all of them, so each profile can switch each one on or off
// and keep its data while off (ConfigSwitch, DefaultSwitch). A private
// profile's are allowed into its private pages. `unpacked_id` gives the id
// of each of `all.unpacked`.
ExtensionList ExtensionsFor(
    const BrowserProfile& profile,
    const ExtensionList& all,
    base::FunctionRef<std::string(const std::string&)> unpacked_id);

// An extension the user installed in a profile, from the Web Store or a
// Settings app's "load unpacked", which every other profile installs too.
struct UserExtension {
  std::string id;
  // The directory it loads from, or empty for one from the Web Store.
  std::string unpacked;

  friend bool operator==(const UserExtension&,
                         const UserExtension&) = default;
};

// The extensions the user installed in any profile (`each`, one list per
// profile) that a profile with `installed` lacks, once each by id, in the
// order first found. The config's own (`config_ids`) are left to the config,
// which installs them everywhere already.
std::vector<UserExtension> UserExtensionsMissing(
    const std::vector<std::vector<UserExtension>>& each,
    const std::set<std::string>& installed,
    const std::set<std::string>& config_ids);

// Whether the config turns extension `id` on in `profile`, or nothing when
// the profile names no extensions and the user switches them.
std::optional<bool> ConfigSwitch(const BrowserProfile& profile,
                                 std::string_view id);

// Whether an extension the config does not switch starts on in `profile`
// when it is first installed there: on, except in a private profile, whose
// pages have always been kept from extensions unless allowed.
bool DefaultSwitch(const BrowserProfile& profile);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_BROWSER_PROFILES_H_
