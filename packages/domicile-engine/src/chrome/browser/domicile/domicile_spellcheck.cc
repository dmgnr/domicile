// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "chrome/browser/domicile/domicile_spellcheck.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/check.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/task/bind_post_task.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/domicile/domicile_browser_windows.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_manager_observer.h"
#include "chrome/browser/spellchecker/spellcheck_custom_dictionary.h"
#include "chrome/browser/spellchecker/spellcheck_factory.h"
#include "chrome/browser/spellchecker/spellcheck_hunspell_dictionary.h"
#include "chrome/browser/spellchecker/spellcheck_service.h"
#include "components/domicile/browser/control_channel.h"
#include "components/domicile/browser/spellcheck_settings.h"
#include "components/domicile/browser/web_view_guest.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/web_contents.h"

namespace domicile {
namespace {

// The desk's spell checking, as the compositor last said, for every profile
// and each one loaded later. Until it says, profiles keep the prefs they
// saved.
class DeskSpellcheck : public ProfileManagerObserver {
 public:
  DeskSpellcheck() {
    observation_.Observe(g_browser_process->profile_manager());
  }

  void Take(const SpellcheckSettings& settings) {
    settings_ = settings;
    for (Profile* profile :
         g_browser_process->profile_manager()->GetLoadedProfiles()) {
      ApplySpellcheck(*profile->GetPrefs(), settings);
    }
  }

  // ProfileManagerObserver:
  void OnProfileAdded(Profile* profile) override {
    if (settings_) {
      ApplySpellcheck(*profile->GetPrefs(), *settings_);
    }
  }

  void OnProfileManagerDestroying() override { observation_.Reset(); }

 private:
  std::optional<SpellcheckSettings> settings_;
  base::ScopedObservation<ProfileManager, ProfileManagerObserver>
      observation_{this};
};

DeskSpellcheck& Desk() {
  static base::NoDestructor<DeskSpellcheck> desk;
  return *desk;
}

// Who hears of the shell's profile's dictionaries as they load.
base::RepeatingCallbackList<void(const std::string&)>& ShellDictionaries() {
  static base::NoDestructor<
      base::RepeatingCallbackList<void(const std::string&)>>
      watchers;
  return *watchers;
}

// The shell's profile, or none before the shell is up.
content::BrowserContext* ShellContext() {
  content::WebContents* shell = DeskShellContents();
  return shell == nullptr ? nullptr : shell->GetBrowserContext();
}

}  // namespace

base::CallbackListSubscription WatchShellSpellcheckDictionaries(
    base::RepeatingCallback<void(const std::string& language)> initialized) {
  // A profile that checks no spelling has no service, and so no dictionaries.
  content::BrowserContext* context = ShellContext();
  SpellcheckService* spellcheck =
      context == nullptr ? nullptr
                         : SpellcheckServiceFactory::GetForContext(context);
  if (spellcheck != nullptr) {
    for (const std::unique_ptr<SpellcheckHunspellDictionary>& dictionary :
         spellcheck->GetHunspellDictionaries()) {
      if (dictionary->IsReady()) {
        initialized.Run(dictionary->GetLanguage());
      }
    }
  }
  return ShellDictionaries().Add(std::move(initialized));
}

void SpellcheckDictionaryInitialized(content::BrowserContext& context,
                                     const std::string& language) {
  if (&context == ShellContext()) {
    ShellDictionaries().Notify(language);
  }
}

void StartSpellcheck() {
  // Created here, on the UI thread, before any channel can call the sink.
  Desk();
  SetSpellcheckSink(base::BindPostTask(
      content::GetUIThreadTaskRunner({}),
      base::BindRepeating([](const SpellcheckSettings& settings) {
        Desk().Take(settings);
      })));
  WebViewGuest::SetAddToDictionary(base::BindRepeating(&AddToDictionary));
}

void AddToDictionary(content::BrowserContext& context,
                     const std::string& word) {
  // A guest's menu offers a word only while its profile checks spelling.
  SpellcheckService* spellcheck =
      SpellcheckServiceFactory::GetForContext(&context);
  CHECK(spellcheck);
  spellcheck->GetCustomDictionary()->AddWord(word);
}

}  // namespace domicile
