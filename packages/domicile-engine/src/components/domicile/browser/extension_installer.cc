// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/extension_installer.h"

namespace domicile {

ExtensionChanges ReconcileExtensions(
    const ExtensionList& wanted,
    const std::set<std::string>& installed,
    const std::map<std::string, std::string>& unpacked,
    const std::set<std::string>& added) {
  ExtensionChanges changes;
  std::set<std::string> kept(wanted.web_store.begin(), wanted.web_store.end());
  for (const std::string& id : wanted.web_store) {
    if (!installed.contains(id)) {
      changes.install_from_web_store.push_back(id);
    }
  }
  for (const std::string& directory : wanted.unpacked) {
    const auto loaded = unpacked.find(directory);
    if (loaded == unpacked.end()) {
      changes.load_unpacked.push_back(directory);
    } else {
      kept.insert(loaded->second);
    }
  }
  for (const std::string& id : added) {
    if (installed.contains(id) && !kept.contains(id)) {
      changes.uninstall.push_back(id);
    }
  }
  for (const std::string& id : kept) {
    if (installed.contains(id) && !added.contains(id)) {
      changes.claim.push_back(id);
    }
  }
  return changes;
}

}  // namespace domicile
