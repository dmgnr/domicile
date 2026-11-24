// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/browser_profiles.h"

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "base/check.h"
#include "base/json/json_reader.h"
#include "base/values.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace domicile {
namespace {

base::DictValue Dict(const std::string& json) {
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  CHECK(parsed) << json;
  return *std::move(parsed);
}

// A message with these sites and a Personal, Work and Private profile.
std::string Message(const std::string& sites) {
  return R"({"profiles":[)"
         R"({"id":"personal","name":"Personal","color":"#0d9488",)"
         R"("private":false,"extensions":null},)"
         R"({"id":"work","name":"Work","color":"#d97706","private":false,)"
         R"("extensions":["aeblfdkhhhdcdjpifhhbdiojplfjncoa"]},)"
         R"({"id":"incognito","name":"Private","color":"#a78bfa",)"
         R"("private":true,"extensions":null}],)"
         R"("default_profile":"personal",)"
         R"("default_private_profile":"incognito",)"
         R"("sites":)" +
         sites + "}";
}

TEST(BrowserProfilesTest, AMessageReadsAsTheConfigWroteIt) {
  std::optional<BrowserProfiles> read =
      ParseBrowserProfiles(Dict(Message(R"({"github.com/acme":"work"})")));

  ASSERT_TRUE(read.has_value());
  ASSERT_EQ(read->profiles.size(), 3u);
  EXPECT_EQ(read->default_profile, "personal");
  EXPECT_EQ(read->default_private_profile, "incognito");
  EXPECT_EQ(read->sites.at("github.com/acme"), "work");
  const BrowserProfile* work = read->Find("work");
  ASSERT_NE(work, nullptr);
  EXPECT_EQ(work->name, "Work");
  EXPECT_FALSE(work->is_private);
  EXPECT_EQ(work->extensions,
            std::vector<std::string>{"aeblfdkhhhdcdjpifhhbdiojplfjncoa"});
  EXPECT_EQ(read->Find("personal")->extensions, std::nullopt);
  EXPECT_TRUE(read->Find("incognito")->is_private);
}

TEST(BrowserProfilesTest, AMessageThatContradictsItselfIsRefused) {
  // A site in no profile, and one in the default profile.
  EXPECT_FALSE(ParseBrowserProfiles(Dict(Message(R"({"acme.com":"office"})"))));
  EXPECT_FALSE(
      ParseBrowserProfiles(Dict(Message(R"({"acme.com":"personal"})"))));
  // A private default, and a default private profile that is not private.
  EXPECT_FALSE(ParseBrowserProfiles(Dict(
      R"({"profiles":[{"id":"incognito","name":"P","color":"#000000",)"
      R"("private":true,"extensions":null}],"default_profile":"incognito",)"
      R"("default_private_profile":"incognito","sites":{}})")));
  EXPECT_FALSE(ParseBrowserProfiles(Dict(
      R"({"profiles":[{"id":"personal","name":"P","color":"#000000",)"
      R"("private":false,"extensions":null}],"default_profile":"personal",)"
      R"("default_private_profile":"personal","sites":{}})")));
  // An id that is no directory name.
  EXPECT_FALSE(ParseBrowserProfiles(
      Dict(R"({"profiles":[{"id":"../p","name":"P","color":"#000000",)"
           R"("private":false,"extensions":null}],"default_profile":"../p",)"
           R"("default_private_profile":"../p","sites":{}})")));
}

// Every profile gets every extension, so each can switch each one and keep
// its data while it is off.
TEST(BrowserProfilesTest, EveryProfileGetsEveryExtension) {
  const ExtensionList all{
      .web_store = {"aeblfdkhhhdcdjpifhhbdiojplfjncoa",
                    "nngceckbapebfimnlniiiahkandclblb"},
      .unpacked = {"/home/me/src/mine"},
  };
  const auto unpacked_id = [](const std::string&) {
    return std::string("mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm");
  };
  const BrowserProfile work{.id = "work",
                            .extensions = std::vector<std::string>{
                                "aeblfdkhhhdcdjpifhhbdiojplfjncoa"}};

  const ExtensionList chosen = ExtensionsFor(work, all, unpacked_id);
  EXPECT_EQ(chosen.web_store, all.web_store);
  EXPECT_EQ(chosen.unpacked, all.unpacked);
  // Its pages are not private, so it leaves where its extensions run as set.
  EXPECT_TRUE(chosen.settings.empty());
}

// A private profile's pages are off the record, so its extensions are allowed
// there; its switches say which run.
TEST(BrowserProfilesTest, APrivateProfilesExtensionsRunInItsPages) {
  const ExtensionList all{
      .web_store = {"nngceckbapebfimnlniiiahkandclblb"},
      .unpacked = {"/home/me/src/mine"},
  };
  const auto unpacked_id = [](const std::string&) {
    return std::string("mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm");
  };
  const BrowserProfile hidden{.id = "private", .is_private = true};

  const ExtensionList chosen = ExtensionsFor(hidden, all, unpacked_id);
  EXPECT_EQ(chosen.settings.at("nngceckbapebfimnlniiiahkandclblb").in_private,
            true);
  EXPECT_EQ(chosen.settings.at("mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm").in_private,
            true);
}

// A profile that names its extensions switches them for the user; one that
// names none leaves them to the user, starting on, or off when private.
TEST(BrowserProfilesTest, TheConfigSwitchesTheExtensionsAProfileNames) {
  const BrowserProfile work{.id = "work",
                            .extensions = std::vector<std::string>{
                                "aeblfdkhhhdcdjpifhhbdiojplfjncoa"}};
  const BrowserProfile personal{.id = "personal"};
  const BrowserProfile hidden{.id = "private", .is_private = true};

  EXPECT_EQ(ConfigSwitch(work, "aeblfdkhhhdcdjpifhhbdiojplfjncoa"), true);
  EXPECT_EQ(ConfigSwitch(work, "nngceckbapebfimnlniiiahkandclblb"), false);
  EXPECT_EQ(ConfigSwitch(personal, "aeblfdkhhhdcdjpifhhbdiojplfjncoa"),
            std::nullopt);
  EXPECT_TRUE(DefaultSwitch(personal));
  EXPECT_FALSE(DefaultSwitch(hidden));
}

// The profiles of Message(sites), as ParseBrowserProfiles reads them.
BrowserProfiles WithSites(const std::string& sites) {
  std::optional<BrowserProfiles> profiles =
      ParseBrowserProfiles(Dict(Message(sites)));
  CHECK(profiles);
  return *std::move(profiles);
}

TEST(BrowserProfilesTest, TheMostSpecificSiteWins) {
  const BrowserProfiles profiles = WithSites(
      R"({"*.acme.com":"work","mail.acme.com":"incognito",)"
      R"("github.com/acme":"work","github.com/acme/public":"incognito"})");
  const auto profile_for = [&profiles](const char* url) {
    return ProfileForUrl(profiles, GURL(url));
  };

  // `*.host` is the host and its subdomains, not a host that ends the same.
  EXPECT_EQ(profile_for("https://acme.com/"), "work");
  EXPECT_EQ(profile_for("https://docs.acme.com/x"), "work");
  EXPECT_EQ(profile_for("https://notacme.com/"), "personal");
  // A host beats `*.host`.
  EXPECT_EQ(profile_for("https://mail.acme.com/"), "incognito");
  // A path is its segments, not a prefix of one.
  EXPECT_EQ(profile_for("https://github.com/acme"), "work");
  EXPECT_EQ(profile_for("https://github.com/acme/repo?q=1"), "work");
  EXPECT_EQ(profile_for("https://github.com/acmecorp"), "personal");
  EXPECT_EQ(profile_for("https://github.com/acme/public/x"), "incognito");
  EXPECT_EQ(profile_for("https://github.com/"), "personal");
  // Only web addresses are routed.
  EXPECT_EQ(profile_for("about:blank"), "personal");
  EXPECT_EQ(profile_for("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/"
                        "x.html"),
            "personal");
}

TEST(BrowserProfilesTest, ASiteForAnAddressIsTheEntryThatRoutesIt) {
  const BrowserProfiles profiles =
      WithSites(R"({"*.acme.com":"work","github.com/acme":"work"})");
  const auto site_for = [&profiles](const char* url) -> std::string {
    const std::string* site = SiteForUrl(profiles, GURL(url));
    return site == nullptr ? "(none)" : *site;
  };

  EXPECT_EQ(site_for("https://docs.acme.com/x"), "*.acme.com");
  EXPECT_EQ(site_for("https://github.com/acme/repo"), "github.com/acme");
  EXPECT_EQ(site_for("https://github.com/"), "(none)");
  EXPECT_EQ(site_for("about:blank"), "(none)");
}

TEST(BrowserProfilesTest, AnExtensionsPageOpensInTheProfileThatAskedForIt) {
  const BrowserProfiles profiles = WithSites(R"({"github.com/acme":"work"})");

  EXPECT_EQ(ProfileForNewWindow(
                profiles, "work",
                GURL("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/"
                     "app/app.html#/setup")),
            "work");
  // A web address goes by its site, whoever asked.
  EXPECT_EQ(ProfileForNewWindow(profiles, "work", GURL("https://example.com/")),
            profiles.default_profile);
  EXPECT_EQ(ProfileForNewWindow(profiles, profiles.default_profile,
                                GURL("https://github.com/acme/repo")),
            "work");
}

TEST(BrowserProfilesTest, PinnedSitesGoUnderTheConfigs) {
  const BrowserProfiles config = WithSites(R"({"*.acme.com":"work"})");
  const BrowserProfiles profiles = WithPinnedSites(
      config, {{"github.com/acme", "work"},
               {"news.example", "incognito"},
               // The config's own site keeps the config's profile.
               {"*.acme.com", "incognito"},
               // No site maps to the default profile.
               {"mail.example", "personal"},
               // A profile the config no longer has.
               {"old.example", "gone"}});

  EXPECT_EQ(profiles.sites,
            (std::map<std::string, std::string>{
                {"*.acme.com", "work"},
                {"github.com/acme", "work"},
                {"news.example", "incognito"}}));
  EXPECT_EQ(ProfileForUrl(profiles, GURL("https://news.example/")),
            "incognito");
}

TEST(BrowserProfilesTest, ASiteKeyIsAHostAWildcardOrAHostAndPath) {
  EXPECT_TRUE(IsSiteKey("github.com"));
  EXPECT_TRUE(IsSiteKey("*.acme.com"));
  EXPECT_TRUE(IsSiteKey("github.com/acme"));
  EXPECT_TRUE(IsSiteKey("github.com/acme/public"));
  EXPECT_TRUE(IsSiteKey("localhost"));

  EXPECT_FALSE(IsSiteKey(""));
  EXPECT_FALSE(IsSiteKey("GitHub.com"));
  EXPECT_FALSE(IsSiteKey("https://github.com"));
  EXPECT_FALSE(IsSiteKey("github.com/"));
  EXPECT_FALSE(IsSiteKey("github.com/acme/"));
  EXPECT_FALSE(IsSiteKey("github.com/acme?x"));
  EXPECT_FALSE(IsSiteKey("*."));
  EXPECT_FALSE(IsSiteKey(".github.com"));
  EXPECT_FALSE(IsSiteKey("github.com:443"));
}

TEST(BrowserProfilesTest, APageMovesWhenRoutingDisagreesAtEitherEnd) {
  const BrowserProfiles profiles =
      WithSites(R"({"*.acme.com":"work"})");
  const GURL personal("https://news.example/");
  const GURL personal_too("https://mail.example/");
  const GURL work("https://docs.acme.com/");
  const GURL work_too("https://mail.acme.com/");

  EXPECT_EQ(RouteNavigation(profiles, "personal", personal, work), "work");
  EXPECT_EQ(RouteNavigation(profiles, "work", work, personal), "personal");
  // Within one profile's sites it stays.
  EXPECT_EQ(RouteNavigation(profiles, "work", work, work_too), std::nullopt);
  EXPECT_EQ(RouteNavigation(profiles, "personal", personal, personal_too),
            std::nullopt);
  // A page the user moved to Work stays there on its own site...
  EXPECT_EQ(RouteNavigation(profiles, "work", personal, personal_too),
            std::nullopt);
  // ...and follows routing when it leaves for another profile's site.
  EXPECT_EQ(RouteNavigation(profiles, "incognito", personal, work), "work");
  // Already where routing would put it.
  EXPECT_EQ(RouteNavigation(profiles, "work", personal, work), std::nullopt);
  // From a page that is no site, such as a new tab page.
  EXPECT_EQ(RouteNavigation(profiles, "personal", GURL("about:blank"), work),
            "work");
  // To one that is no site.
  EXPECT_EQ(
      RouteNavigation(profiles, "work", work, GURL("about:blank")),
      std::nullopt);
}

TEST(BrowserProfilesTest, AProfileGetsTheExtensionsTheUserInstalledInAnother) {
  const UserExtension rabby{"acmacodkjbdgmoleebolmdjonilkdbch", ""};
  const UserExtension ublock{"ddkjiahejlhfcafbddmgiahcphecmpfh", ""};
  const UserExtension mine{"abcdefghijklmnopabcdefghijklmnop",
                           "/home/me/src/mine"};
  const std::vector<std::vector<UserExtension>> each = {
      {rabby, ublock}, {mine, rabby}, {}};
  // A profile with none gets each once, in the order first found.
  EXPECT_EQ(UserExtensionsMissing(each, {}, {}),
            (std::vector<UserExtension>{rabby, ublock, mine}));
  // One with some gets the rest.
  EXPECT_EQ(UserExtensionsMissing(each, {rabby.id, mine.id}, {}),
            (std::vector<UserExtension>{ublock}));
  // The config's own are the config's to install.
  EXPECT_EQ(UserExtensionsMissing(each, {}, {ublock.id}),
            (std::vector<UserExtension>{rabby, mine}));
}

TEST(BrowserProfilesTest, OnlyNavigationsTheUserTookMoveAPage) {
  const auto user = [](bool renderer_initiated, bool user_gesture,
                       ui::PageTransition transition) {
    return IsUserNavigation(/*main_frame=*/true, /*same_document=*/false,
                            renderer_initiated, user_gesture, /*post=*/false,
                            transition);
  };
  // A click, the address bar, back and forward.
  EXPECT_TRUE(user(true, true, ui::PAGE_TRANSITION_LINK));
  EXPECT_TRUE(user(false, false, ui::PAGE_TRANSITION_TYPED));
  EXPECT_TRUE(user(false, false, ui::PageTransitionFromInt(
                                     ui::PAGE_TRANSITION_LINK |
                                     ui::PAGE_TRANSITION_FORWARD_BACK)));
  // The page's own script, and reloads.
  EXPECT_FALSE(user(true, false, ui::PAGE_TRANSITION_LINK));
  EXPECT_FALSE(user(false, false, ui::PAGE_TRANSITION_RELOAD));
  // A subframe, a fragment, a POST.
  EXPECT_FALSE(IsUserNavigation(false, false, true, true, false,
                                ui::PAGE_TRANSITION_LINK));
  EXPECT_FALSE(IsUserNavigation(true, true, true, true, false,
                                ui::PAGE_TRANSITION_LINK));
  EXPECT_FALSE(IsUserNavigation(true, false, true, true, true,
                                ui::PAGE_TRANSITION_FORM_SUBMIT));
}

}  // namespace
}  // namespace domicile
