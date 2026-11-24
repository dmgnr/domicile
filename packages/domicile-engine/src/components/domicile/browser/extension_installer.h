// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_EXTENSION_INSTALLER_H_
#define COMPONENTS_DOMICILE_BROWSER_EXTENSION_INSTALLER_H_

#include <map>
#include <set>
#include <string>
#include <vector>

#include "components/domicile/browser/extension_settings.h"

namespace domicile {

// The extensions named in the config, from the compositor's `extensions`
// message. See docs/architecture/EXTENSIONS.md.
struct ExtensionList {
  // Chrome Web Store ids.
  std::vector<std::string> web_store;
  // Absolute directories holding an unpacked extension.
  std::vector<std::string> unpacked;
  // Settings by id, for these extensions or any other.
  ExtensionSettingsMap settings;
};

// The changes that bring a profile in line with an `ExtensionList`.
struct ExtensionChanges {
  // Ids to install from the Web Store.
  std::vector<std::string> install_from_web_store;
  // Directories to load.
  std::vector<std::string> load_unpacked;
  // Ids to uninstall.
  std::vector<std::string> uninstall;
  // Ids named and installed that `added` lacks, to record as added.
  std::vector<std::string> claim;
};

// Decides which extensions to install, load and uninstall.
// chrome/browser/domicile/domicile_extension_installer.h applies the result.
//
// `installed` is every extension in the profile, `unpacked` maps each loaded
// directory to its id, and `added` is what this installer installed.
//
// - Skips what is already present. Each shell window sends the list on
//   connect, and reinstalling an id is a DFATAL in PendingExtensionManager.
//   Reloading a directory restarts its extension.
// - Uninstalls only what this installer added. Browser windows share the
//   profile, so it may hold extensions the user installed.
// - Claims what it names and finds installed but not added: a crash can lose
//   the record, and the user may have installed it first.
ExtensionChanges ReconcileExtensions(
    const ExtensionList& wanted,
    const std::set<std::string>& installed,
    const std::map<std::string, std::string>& unpacked,
    const std::set<std::string>& added);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_EXTENSION_INSTALLER_H_
