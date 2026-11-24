// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/common/electron_schemes.h"

#include <algorithm>
#include <iterator>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/logging.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/types/expected.h"

namespace domicile {

namespace {

// Grants `privilege` to `scheme`, or says it is not one.
base::expected<void, std::string> Grant(std::string_view privilege,
                                        ElectronScheme& scheme) {
  if (privilege == "standard") {
    scheme.standard = true;
  } else if (privilege == "secure") {
    scheme.secure = true;
  } else if (privilege == "bypassCSP") {
    scheme.bypass_csp = true;
  } else if (privilege == "corsEnabled") {
    scheme.cors_enabled = true;
  } else if (privilege == "supportFetchAPI") {
    scheme.supports_fetch = true;
  } else if (privilege != "stream" && privilege != "codeCache" &&
             privilege != "allowServiceWorkers") {
    return base::unexpected(
        base::StrCat({privilege, " is not an Electron scheme privilege"}));
  }
  return base::ok();
}

base::expected<ElectronScheme, std::string> ParseScheme(
    std::string_view entry) {
  const size_t colon = entry.find(':');
  if (colon == std::string_view::npos) {
    return base::unexpected(
        base::StrCat({"\"", entry, "\" is not scheme:privileges"}));
  }
  ElectronScheme scheme{.scheme = std::string(entry.substr(0, colon))};
  if (!IsElectronHandleableScheme(scheme.scheme) || scheme.scheme == "http" ||
      scheme.scheme == "https" || scheme.scheme == "file") {
    return base::unexpected(
        base::StrCat({"an app cannot register ", scheme.scheme, ":"}));
  }
  for (std::string_view privilege : base::SplitStringPiece(
           entry.substr(colon + 1), ",", base::TRIM_WHITESPACE,
           base::SPLIT_WANT_NONEMPTY)) {
    if (base::expected<void, std::string> granted = Grant(privilege, scheme);
        !granted.has_value()) {
      return base::unexpected(std::move(granted.error()));
    }
  }
  return scheme;
}

}  // namespace

bool IsElectronHandleableScheme(std::string_view scheme) {
  // The schemes content, Blink and the engine give their own meaning. An
  // app's handler for one would either never run or take over something
  // that is not the app's.
  static constexpr std::string_view kReserved[] = {"about",
                                                   "blob",
                                                   "chrome",
                                                   "chrome-error",
                                                   "chrome-extension",
                                                   "chrome-native",
                                                   "chrome-search",
                                                   "chrome-untrusted",
                                                   "data",
                                                   "devtools",
                                                   "domicile",
                                                   "filesystem",
                                                   "googlechrome",
                                                   "intent",
                                                   "isolated-app",
                                                   "javascript",
                                                   "view-source",
                                                   "ws",
                                                   "wss"};
  return !scheme.empty() && base::IsAsciiLower(scheme[0]) &&
         std::ranges::all_of(scheme,
                             [](char c) {
                               return base::IsAsciiLower(c) ||
                                      base::IsAsciiDigit(c) || c == '+' ||
                                      c == '-' || c == '.';
                             }) &&
         std::ranges::find(kReserved, scheme) == std::end(kReserved);
}

base::expected<std::vector<ElectronScheme>, std::string> ParseElectronSchemes(
    std::string_view value) {
  std::vector<ElectronScheme> schemes;
  if (value.empty()) {
    return schemes;
  }
  // Every entry, empty ones too: "app:standard;" is a mistake, not a list.
  for (std::string_view entry : base::SplitStringPiece(
           value, ";", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
    base::expected<ElectronScheme, std::string> scheme = ParseScheme(entry);
    if (!scheme.has_value()) {
      return base::unexpected(std::move(scheme.error()));
    } else if (std::ranges::contains(schemes, scheme->scheme,
                                     &ElectronScheme::scheme)) {
      return base::unexpected(
          base::StrCat({scheme->scheme, ": is named twice"}));
    }
    schemes.push_back(std::move(*scheme));
  }
  return schemes;
}

std::vector<std::string> ElectronSchemePrivileges(
    const ElectronScheme& scheme) {
  std::vector<std::string> privileges;
  if (scheme.standard) {
    privileges.push_back("standard");
  }
  if (scheme.secure) {
    privileges.push_back("secure");
  }
  if (scheme.bypass_csp) {
    privileges.push_back("bypassCSP");
  }
  if (scheme.cors_enabled) {
    privileges.push_back("corsEnabled");
  }
  if (scheme.supports_fetch) {
    privileges.push_back("supportFetchAPI");
  }
  return privileges;
}

std::vector<ElectronScheme> ElectronSchemesIn(
    const base::CommandLine& command_line) {
  base::expected<std::vector<ElectronScheme>, std::string> schemes =
      ParseElectronSchemes(
          command_line.GetSwitchValueASCII(kDomicileElectronSchemesSwitch));
  if (!schemes.has_value()) {
    // The supervisor wrote it, so this is the platform's bug. Each app that
    // needs a scheme says so and runs on its own Electron.
    LOG(ERROR) << "--" << kDomicileElectronSchemesSwitch
               << " registers no schemes: " << schemes.error();
    return {};
  }
  return std::move(*schemes);
}

}  // namespace domicile
