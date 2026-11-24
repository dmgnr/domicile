// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_session_events.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace domicile {
namespace {

TEST(ElectronSessionEventsTest, EachIsALine) {
  EXPECT_EQ(ElectronPreconnected("persist:a", GURL("https://a.test/x"), false),
            "{\"allow_credentials\":false,\"session\":\"persist:a\","
            "\"type\":\"preconnect\",\"url\":\"https://a.test/x\"}\n");
  EXPECT_EQ(ElectronSpellcheckDictionaryInitialized("en-US"),
            "{\"language\":\"en-US\","
            "\"type\":\"spellcheck_dictionary_initialized\"}\n");
  EXPECT_EQ(ElectronGpuInfoUpdated(), "{\"type\":\"gpu_info_update\"}\n");
}

}  // namespace
}  // namespace domicile
