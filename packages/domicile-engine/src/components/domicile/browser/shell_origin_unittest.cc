// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_origin.h"

#include "components/domicile/common/domicile_scheme.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_util.h"

namespace domicile {
namespace {

// Registers the scheme as the engine does. Unregistered, a domicile:// URL has
// an opaque origin and the refusals below would pass for the wrong reason.
class ShellOriginTest : public testing::Test {
 protected:
  ShellOriginTest() {
    url::AddStandardScheme(kDomicileScheme, url::SCHEME_WITH_HOST);
  }

 private:
  url::ScopedSchemeRegistryForTests scheme_registry_;
};

url::Origin OriginOf(const char* url) {
  return url::Origin::Create(GURL(url));
}

TEST_F(ShellOriginTest, TheShellIsTheShell) {
  EXPECT_TRUE(IsShellOrigin(OriginOf("domicile://shell/")));
  EXPECT_TRUE(IsShellOrigin(OriginOf("domicile://shell/?kind=a")));
}

TEST_F(ShellOriginTest, NoOtherPageIsTheShell) {
  EXPECT_FALSE(IsShellOrigin(OriginOf("https://example.com/")));
  EXPECT_FALSE(IsShellOrigin(OriginOf("file:///tmp/app.html")));
  // Same scheme, other host: the user's files, never a document that embeds.
  EXPECT_FALSE(IsShellOrigin(OriginOf("domicile://home/a.html")));
  EXPECT_FALSE(IsShellOrigin(url::Origin()));
}

TEST_F(ShellOriginTest, TheShellAndAppsAreCrossOriginIsolated) {
  EXPECT_TRUE(IsCrossOriginIsolatedOrigin(OriginOf("domicile://shell/")));
  EXPECT_TRUE(IsCrossOriginIsolatedOrigin(
      OriginOf("domicile://app-0123456789abcdef0123456789abcdef/")));
}

TEST_F(ShellOriginTest, NoOtherPageIsCrossOriginIsolated) {
  EXPECT_FALSE(IsCrossOriginIsolatedOrigin(OriginOf("https://example.com/")));
  // The user's files are data, not a program.
  EXPECT_FALSE(IsCrossOriginIsolatedOrigin(OriginOf("domicile://home/a.html")));
  // Not the shape an app's host has.
  EXPECT_FALSE(IsCrossOriginIsolatedOrigin(OriginOf("domicile://app-x/")));
  EXPECT_FALSE(IsCrossOriginIsolatedOrigin(url::Origin()));
}

}  // namespace
}  // namespace domicile
