// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_COMMON_ELECTRON_SCHEMES_H_
#define COMPONENTS_DOMICILE_COMMON_ELECTRON_SCHEMES_H_

#include <string>
#include <string_view>
#include <vector>

#include "base/command_line.h"
#include "base/types/expected.h"

namespace domicile {

// Electron apps' own schemes, registered as the engine starts, with the
// privileges each app asked for (protocol.registerSchemesAsPrivileged).
// Chromium registers schemes only as each process starts, so the supervisor
// passes every scheme it knows of, from the quirks table and from apps'
// earlier runs, and the browser hands the switch to every child process. See
// "Requests" in docs/architecture/ELECTRON-APPS.md.
//
//   --domicile-electron-schemes=app:standard,secure;cowork-artifact:standard
//
// Each privilege is Electron's own name for it.
inline constexpr char kDomicileElectronSchemesSwitch[] =
    "domicile-electron-schemes";

// Whether an app may handle `scheme`: http, https, file, or a scheme of
// its own. Never one the engine or the web gives a meaning (about:, data:,
// chrome:, domicile: and their kind).
bool IsElectronHandleableScheme(std::string_view scheme);

// One of an app's own schemes and the privileges the engine grants it.
struct ElectronScheme {
  std::string scheme;
  // A URL with a host and an origin, as http: has.
  bool standard = false;
  // A trustworthy origin, as https: is.
  bool secure = false;
  // Its pages' resources load whatever the page's CSP says.
  bool bypass_csp = false;
  // Other origins may fetch it under CORS.
  bool cors_enabled = false;
  // Its pages may fetch().
  bool supports_fetch = false;

  friend bool operator==(const ElectronScheme&,
                         const ElectronScheme&) = default;
};

// The schemes in a --domicile-electron-schemes value, or why it is wrong. A
// scheme an app may not register (http, https, file, or one that is not an
// app's to handle) is wrong, as is one named twice. Electron's stream,
// codeCache and allowServiceWorkers are known but not granted yet.
base::expected<std::vector<ElectronScheme>, std::string> ParseElectronSchemes(
    std::string_view value);

// The privileges the engine grants `scheme`, by Electron's names.
std::vector<std::string> ElectronSchemePrivileges(const ElectronScheme& scheme);

// The schemes `command_line` registers. A wrong value is logged and
// registers none: the apps it names run on their own Electron instead.
std::vector<ElectronScheme> ElectronSchemesIn(
    const base::CommandLine& command_line);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_COMMON_ELECTRON_SCHEMES_H_
