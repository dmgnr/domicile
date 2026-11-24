// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/spellcheck_settings.h"

#include "base/values.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/testing_pref_service.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// components/spellcheck/browser/pref_names.h's, whose target brings //content.
constexpr char kSpellCheckEnable[] = "browser.enable_spellchecking";
constexpr char kSpellCheckDictionaries[] = "spellcheck.dictionaries";
constexpr char kSpellCheckUseSpellingService[] =
    "spellcheck.use_spelling_service";

// Registers the prefs as a fresh profile has them: checking in the UI's
// language, and asking Google's spelling service.
class SpellcheckSettingsTest : public testing::Test {
 protected:
  SpellcheckSettingsTest() {
    prefs_.registry()->RegisterBooleanPref(kSpellCheckEnable,
                                           true);
    prefs_.registry()->RegisterListPref(
        kSpellCheckDictionaries,
        base::ListValue().Append("en-US"));
    prefs_.registry()->RegisterBooleanPref(
        kSpellCheckUseSpellingService, true);
  }

  TestingPrefServiceSimple prefs_;
};

TEST_F(SpellcheckSettingsTest, TheProfileChecksInTheDesksLanguages) {
  ApplySpellcheck(prefs_, {.enabled = true, .languages = {"de-DE", "fr-FR"}});

  EXPECT_TRUE(prefs_.GetBoolean(kSpellCheckEnable));
  EXPECT_EQ(prefs_.GetList(kSpellCheckDictionaries),
            base::ListValue().Append("de-DE").Append("fr-FR"));
}

TEST_F(SpellcheckSettingsTest, ADeskCanTurnCheckingOff) {
  ApplySpellcheck(prefs_, {.enabled = false, .languages = {"en-US"}});

  EXPECT_FALSE(prefs_.GetBoolean(kSpellCheckEnable));
}

TEST_F(SpellcheckSettingsTest, ALanguageNamedLooselyGetsItsDictionary) {
  // Chrome has one Hungarian dictionary, named "hu".
  ApplySpellcheck(prefs_, {.enabled = true, .languages = {"hu-HU"}});

  EXPECT_EQ(prefs_.GetList(kSpellCheckDictionaries),
            base::ListValue().Append("hu"));
}

TEST_F(SpellcheckSettingsTest, ALanguageWithNoDictionaryIsLeftOut) {
  // Chrome has no Zulu dictionary.
  ApplySpellcheck(prefs_, {.enabled = true, .languages = {"zu-ZA", "de-DE"}});

  EXPECT_EQ(prefs_.GetList(kSpellCheckDictionaries),
            base::ListValue().Append("de-DE"));
}

TEST_F(SpellcheckSettingsTest, WordsNeverGoToGoogle) {
  ApplySpellcheck(prefs_, {.enabled = true, .languages = {"en-US"}});

  EXPECT_FALSE(
      prefs_.GetBoolean(kSpellCheckUseSpellingService));
}

}  // namespace
}  // namespace domicile
