// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_session_events.h"

#include <string>
#include <string_view>
#include <utility>

#include "base/check.h"
#include "base/json/json_writer.h"
#include "base/values.h"
#include "url/gurl.h"

namespace domicile {
namespace {

std::string Line(base::DictValue event) {
  std::string line;
  // Events hold only strings and booleans, so a write failure is a bug.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

}  // namespace

std::string ElectronPreconnected(std::string_view session,
                                 const GURL& url,
                                 bool allow_credentials) {
  return Line(base::DictValue()
                  .Set("type", "preconnect")
                  .Set("session", session)
                  .Set("url", url.spec())
                  .Set("allow_credentials", allow_credentials));
}

std::string ElectronSpellcheckDictionaryInitialized(std::string_view language) {
  return Line(base::DictValue()
                  .Set("type", "spellcheck_dictionary_initialized")
                  .Set("language", language));
}

std::string ElectronGpuInfoUpdated() {
  return Line(base::DictValue().Set("type", "gpu_info_update"));
}

}  // namespace domicile
