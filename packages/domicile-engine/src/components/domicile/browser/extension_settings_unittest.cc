// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/extension_settings.h"

#include <optional>
#include <string>

#include "base/check.h"
#include "base/json/json_reader.h"
#include "base/values.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

constexpr char kDark[] = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
constexpr char kMonkey[] = "jinjaccalgkegednnccohejagnlnfdag";

base::DictValue Dict(const char* json) {
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  CHECK(parsed);
  return *std::move(parsed);
}

TEST(ExtensionSettingsTest, ReadsEachSettingAsTheConfigSpellsIt) {
  const std::optional<ExtensionSettingsMap> read = ParseExtensionSettings(
      Dict(R"({"eimadpbcbfnmbkopoojfekhnkhdbieeh":{"private":true,)"
           R"("file_access":false,"site_access":["github.com","*.example"]},)"
           R"("jinjaccalgkegednnccohejagnlnfdag":{"user_scripts":true,)"
           R"("site_access":"on_click"}})"));

  ASSERT_TRUE(read.has_value());
  ExtensionSettings dark;
  dark.in_private = true;
  dark.file_access = false;
  dark.site_access = SiteAccess::kSpecificSites;
  dark.sites = {"github.com", "*.example"};
  ExtensionSettings monkey;
  monkey.user_scripts = true;
  monkey.site_access = SiteAccess::kOnClick;
  EXPECT_EQ(*read, (ExtensionSettingsMap{{kDark, dark}, {kMonkey, monkey}}));
}

TEST(ExtensionSettingsTest, RefusesWhatItCannotRead) {
  // A setting it does not know, a switch that is not a boolean, a mode that
  // is not one, and a site that is not a host.
  EXPECT_FALSE(ParseExtensionSettings(
      Dict(R"({"eimadpbcbfnmbkopoojfekhnkhdbieeh":{"pinned":true}})")));
  EXPECT_FALSE(ParseExtensionSettings(
      Dict(R"({"eimadpbcbfnmbkopoojfekhnkhdbieeh":{"private":"yes"}})")));
  EXPECT_FALSE(ParseExtensionSettings(
      Dict(R"({"eimadpbcbfnmbkopoojfekhnkhdbieeh":{"site_access":"often"}})")));
  EXPECT_FALSE(ParseExtensionSettings(
      Dict(R"({"eimadpbcbfnmbkopoojfekhnkhdbieeh":)"
           R"({"site_access":["https://github.com/"]}})")));
}

TEST(ExtensionSettingsTest, WritesWhatItReads) {
  // The installer stores the config's settings in a pref this way.
  const base::DictValue spelled = Dict(
      R"({"eimadpbcbfnmbkopoojfekhnkhdbieeh":{"private":true,)"
      R"("site_access":["github.com"]},)"
      R"("jinjaccalgkegednnccohejagnlnfdag":{"site_access":"all_sites"}})");

  EXPECT_EQ(ExtensionSettingsValue(*ParseExtensionSettings(spelled)), spelled);
}

TEST(ExtensionSettingsTest, SitesAreHostsChromeGrantsOnEveryScheme) {
  EXPECT_EQ(SitePattern("github.com"), "*://github.com/*");
  EXPECT_EQ(SitePattern("*.example"), "*://*.example/*");
  EXPECT_EQ(SitePattern("GitHub.com"), "*://github.com/*");
  EXPECT_EQ(SitePattern(""), std::nullopt);
  EXPECT_EQ(SitePattern("https://github.com"), std::nullopt);
  EXPECT_EQ(SitePattern("github.com/path"), std::nullopt);
  EXPECT_EQ(SitePattern("git hub.com"), std::nullopt);
}

TEST(ExtensionSettingsTest, SitesAreHostsURLPatternCanParse) {
  // URLPattern refuses each of these, and granting one would CHECK.
  EXPECT_EQ(SitePattern("."), std::nullopt);
  EXPECT_EQ(SitePattern("*.."), std::nullopt);
  EXPECT_EQ(SitePattern("a..b"), std::nullopt);
  EXPECT_EQ(SitePattern("github.com."), std::nullopt);
  EXPECT_EQ(SitePattern("-github.com"), std::nullopt);
  EXPECT_EQ(SitePattern("foo.123"), std::nullopt);
  EXPECT_EQ(SitePattern("1.2.3.999"), std::nullopt);
  EXPECT_EQ(SitePattern("*.10.0.0.1"), std::nullopt);
  EXPECT_EQ(SitePattern("010.0.0.1"), std::nullopt);
  // A hex number, which a URL reads as an address.
  EXPECT_EQ(SitePattern("foo.0x1f"), std::nullopt);
  EXPECT_EQ(SitePattern("0x7f"), std::nullopt);
  // A dotted IPv4 address is a site.
  EXPECT_EQ(SitePattern("10.0.0.1"), "*://10.0.0.1/*");
  EXPECT_EQ(SitePattern("localhost"), "*://localhost/*");
}

TEST(ExtensionSettingsTest, WhatTheConfigNamesIsSet) {
  ExtensionSettings dark;
  dark.in_private = true;
  dark.site_access = SiteAccess::kOnClick;

  EXPECT_EQ(ReconcileSettings(/*wanted=*/{{kDark, dark}}, /*previous=*/{}),
            (ExtensionSettingsMap{{kDark, dark}}));
}

TEST(ExtensionSettingsTest, WhatTheConfigNoLongerNamesGoesBackToChromes) {
  // Chrome's defaults: kept out of private windows and local files, no user
  // scripts, and every site the extension asks for. A setting the config
  // never named is the user's, so it is left alone.
  ExtensionSettings before;
  before.in_private = true;
  before.file_access = true;
  before.user_scripts = true;
  before.site_access = SiteAccess::kOnClick;
  ExtensionSettings still;
  still.in_private = true;

  ExtensionSettings reset;
  reset.in_private = true;
  reset.file_access = false;
  reset.user_scripts = false;
  reset.site_access = SiteAccess::kAllSites;
  ExtensionSettings gone;
  gone.in_private = false;
  EXPECT_EQ(ReconcileSettings(/*wanted=*/{{kDark, still}},
                              /*previous=*/{{kDark, before}, {kMonkey, still}}),
            (ExtensionSettingsMap{{kDark, reset}, {kMonkey, gone}}));
}

TEST(ExtensionSettingsTest, ASettingTheConfigSetsIsNamed) {
  ExtensionSettings configured;
  configured.file_access = false;
  configured.site_access = SiteAccess::kOnClick;
  ExtensionSettings wanted;
  wanted.in_private = true;
  EXPECT_EQ(SetByConfig(wanted, configured), std::nullopt);

  wanted.site_access = SiteAccess::kAllSites;
  EXPECT_EQ(SetByConfig(wanted, configured), "site_access");
}

}  // namespace
}  // namespace domicile
