// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/common/electron_schemes.h"

#include <string>
#include <vector>

#include "base/command_line.h"
#include "base/types/expected.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

TEST(ElectronSchemesTest, AnAppHandlesTheWebsSchemesAndItsOwn) {
  EXPECT_TRUE(IsElectronHandleableScheme("https"));
  EXPECT_TRUE(IsElectronHandleableScheme("http"));
  EXPECT_TRUE(IsElectronHandleableScheme("file"));
  EXPECT_TRUE(IsElectronHandleableScheme("app"));
  EXPECT_TRUE(IsElectronHandleableScheme("cowork-artifact"));
  EXPECT_TRUE(IsElectronHandleableScheme("vscode-file"));
  EXPECT_FALSE(IsElectronHandleableScheme(""));
  EXPECT_FALSE(IsElectronHandleableScheme("App"));
  EXPECT_FALSE(IsElectronHandleableScheme("1app"));
  EXPECT_FALSE(IsElectronHandleableScheme("a b"));
  for (const char* scheme :
       {"about", "blob", "chrome", "chrome-extension", "chrome-untrusted",
        "data", "devtools", "domicile", "filesystem", "javascript",
        "view-source", "ws", "wss"}) {
    EXPECT_FALSE(IsElectronHandleableScheme(scheme)) << scheme;
  }
}

TEST(ElectronSchemesTest, ParsesEachSchemeWithItsPrivileges) {
  EXPECT_EQ(ParseElectronSchemes(
                "app:standard,secure;cowork-artifact:standard,secure,"
                "supportFetchAPI,corsEnabled,bypassCSP;claude-media:"),
            (std::vector<ElectronScheme>{
                {.scheme = "app", .standard = true, .secure = true},
                {.scheme = "cowork-artifact",
                 .standard = true,
                 .secure = true,
                 .bypass_csp = true,
                 .cors_enabled = true,
                 .supports_fetch = true},
                {.scheme = "claude-media"},
            }));
}

TEST(ElectronSchemesTest, NothingIsNoSchemes) {
  EXPECT_EQ(ParseElectronSchemes(""), std::vector<ElectronScheme>{});
}

TEST(ElectronSchemesTest, KnowsThePrivilegesItDoesNotGrant) {
  // Electron's own names for them, which the engine does not grant yet.
  EXPECT_EQ(ParseElectronSchemes("app:standard,stream,codeCache,"
                                 "allowServiceWorkers"),
            (std::vector<ElectronScheme>{{.scheme = "app", .standard = true}}));
}

TEST(ElectronSchemesTest, RefusesWhatNoAppMayRegister) {
  for (const char* value :
       {"http:standard", "https:secure", "file:standard", "domicile:standard",
        "chrome:secure", "App:standard", "app", "app:standard;app:secure",
        "app:standard,flying", "app:standard;", ";app:standard"}) {
    EXPECT_FALSE(ParseElectronSchemes(value).has_value()) << value;
  }
}

TEST(ElectronSchemesTest, PrivilegesHaveElectronsNames) {
  EXPECT_EQ(ElectronSchemePrivileges(ElectronScheme{.scheme = "app",
                                                    .standard = true,
                                                    .secure = true,
                                                    .bypass_csp = true,
                                                    .cors_enabled = true,
                                                    .supports_fetch = true}),
            (std::vector<std::string>{"standard", "secure", "bypassCSP",
                                      "corsEnabled", "supportFetchAPI"}));
  EXPECT_EQ(ElectronSchemePrivileges(ElectronScheme{.scheme = "app"}),
            std::vector<std::string>{});
}

TEST(ElectronSchemesTest, ReadsTheSwitch) {
  base::CommandLine command_line(base::CommandLine::NO_PROGRAM);
  EXPECT_EQ(ElectronSchemesIn(command_line), std::vector<ElectronScheme>{});
  command_line.AppendSwitchASCII(kDomicileElectronSchemesSwitch,
                                 "app:standard");
  EXPECT_EQ(ElectronSchemesIn(command_line),
            (std::vector<ElectronScheme>{{.scheme = "app", .standard = true}}));
}

TEST(ElectronSchemesTest, ABadSwitchRegistersNone) {
  base::CommandLine command_line(base::CommandLine::NO_PROGRAM);
  command_line.AppendSwitchASCII(kDomicileElectronSchemesSwitch,
                                 "app:standard;https:secure");
  EXPECT_EQ(ElectronSchemesIn(command_line), std::vector<ElectronScheme>{});
}

}  // namespace
}  // namespace domicile
