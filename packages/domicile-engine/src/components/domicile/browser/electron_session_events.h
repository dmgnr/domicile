// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_ELECTRON_SESSION_EVENTS_H_
#define COMPONENTS_DOMICILE_BROWSER_ELECTRON_SESSION_EVENTS_H_

#include <string>
#include <string_view>

#include "url/gurl.h"

namespace domicile {

// Events of an app's sessions and of the engine, on the Electron socket (see
// electron_protocol.h), which the engine sends only after the app's hello:
//
//   -> {"type":"preconnect","session":"","url":"https://a.test/",
//       "allow_credentials":true}
//        (a page's resource hint opened a connection: Session's
//        `preconnect`)
//   -> {"type":"spellcheck_dictionary_initialized","language":"en-US"}
//        (a dictionary the engine checks spelling with is loaded: every
//        session's `spellcheck-dictionary-initialized`, as the app's
//        sessions share the engine's dictionaries)
//   -> {"type":"gpu_info_update"}
//        (the engine learned more of its GPU: app's `gpu-info-update`)

std::string ElectronPreconnected(std::string_view session,
                                 const GURL& url,
                                 bool allow_credentials);
std::string ElectronSpellcheckDictionaryInitialized(std::string_view language);
std::string ElectronGpuInfoUpdated();

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_ELECTRON_SESSION_EVENTS_H_
