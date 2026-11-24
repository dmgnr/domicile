// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SPELLCHECK_SETTINGS_H_
#define COMPONENTS_DOMICILE_BROWSER_SPELLCHECK_SETTINGS_H_

#include <string>
#include <vector>

class PrefService;

namespace domicile {

// The config's `spellcheck`, as the compositor sends it on the control
// channel.
struct SpellcheckSettings {
  bool enabled;
  // Language tags, such as "en-US".
  std::vector<std::string> languages;

  friend bool operator==(const SpellcheckSettings&,
                         const SpellcheckSettings&) = default;
};

// Makes a profile check spelling as `settings` say, in Chrome's spell check
// prefs, which its SpellcheckService follows as they change.
//
// - Each language becomes the dictionary Chrome has for it ("hu-HU" is "hu").
//   One with none is logged and left out.
// - Words never go to Google's spelling service: the dictionaries ship with
//   the engine, and suggestions come from them alone.
void ApplySpellcheck(PrefService& prefs, const SpellcheckSettings& settings);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SPELLCHECK_SETTINGS_H_
