// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/spellcheck_settings.h"

#include <string>
#include <utility>

#include "base/logging.h"
#include "base/values.h"
#include "components/prefs/pref_service.h"
#include "components/spellcheck/common/spellcheck_common.h"

namespace domicile {
namespace {

// From components/spellcheck/browser/pref_names.h, whose target brings
// //content.
constexpr char kSpellCheckEnable[] = "browser.enable_spellchecking";
constexpr char kSpellCheckDictionaries[] = "spellcheck.dictionaries";
constexpr char kSpellCheckUseSpellingService[] =
    "spellcheck.use_spelling_service";

}  // namespace

void ApplySpellcheck(PrefService& prefs, const SpellcheckSettings& settings) {
  base::ListValue dictionaries;
  for (const std::string& language : settings.languages) {
    const std::string dictionary =
        spellcheck::GetCorrespondingSpellCheckLanguage(language);
    if (dictionary.empty()) {
      LOG(ERROR) << "domicile: the config's spellcheck.languages names \""
                 << language
                 << "\", which the engine has no dictionary for. Spelling is "
                    "checked in the others.";
    } else {
      dictionaries.Append(dictionary);
    }
  }
  prefs.SetBoolean(kSpellCheckEnable, settings.enabled);
  prefs.SetList(kSpellCheckDictionaries, std::move(dictionaries));
  prefs.SetBoolean(kSpellCheckUseSpellingService, false);
}

}  // namespace domicile
