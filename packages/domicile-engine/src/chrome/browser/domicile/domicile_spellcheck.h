// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_SPELLCHECK_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_SPELLCHECK_H_

#include <string>

#include "base/callback_list.h"
#include "base/functional/callback.h"

namespace content {
class BrowserContext;
}  // namespace content

namespace domicile {

// Spell checking in pages, with Chrome's SpellcheckService and the Hunspell
// dictionaries that ship beside the engine (patch 0246: never downloaded).
//
// - The config's `spellcheck` comes on the control channel and goes into
//   every profile's prefs, and every profile loaded after.
// - A context menu's misspelling, its suggestions and "Add to dictionary" are
//   the shell's: see WebViewGuest::ReplaceMisspelling.

// Takes the desk's spell checking from the control channel, and adds words
// for <webview> context menus. Once, from StartDesk.
void StartSpellcheck();

// Adds `word` to `context`'s own dictionary. WebViewGuest's
// AddToDictionaryCallback.
void AddToDictionary(content::BrowserContext& context, const std::string& word);

// Runs `initialized` with the language of each dictionary the shell's profile
// has loaded, now and as each loads, until the subscription goes. Electron
// apps' sessions are partitions of that profile, so these are theirs: see
// "Session events" in docs/architecture/ELECTRON-APPS.md.
base::CallbackListSubscription WatchShellSpellcheckDictionaries(
    base::RepeatingCallback<void(const std::string& language)> initialized);

// `context`'s dictionary for `language` loaded. Patch 0270 calls it from
// SpellcheckService.
void SpellcheckDictionaryInitialized(content::BrowserContext& context,
                                     const std::string& language);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_SPELLCHECK_H_
