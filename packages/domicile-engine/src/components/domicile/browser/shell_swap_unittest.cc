// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_swap.h"

#include <optional>
#include <string>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "components/domicile/common/domicile_scheme.h"
#include "testing/gmock/include/gmock/gmock.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

using ::testing::ElementsAre;
using ::testing::HasSubstr;

constexpr base::TimeDelta kPatience = base::Seconds(5);

constexpr char kWhy[] = "the shell's Shell threw: TypeError: x is undefined";

base::CommandLine Serving(const std::string& root, const std::string& module) {
  base::CommandLine command_line(base::CommandLine::NO_PROGRAM);
  command_line.AppendSwitchPath(kDomicileShellRootSwitch,
                                base::FilePath(root));
  command_line.AppendSwitchASCII(kDomicileShellModuleSwitch, module);
  return command_line;
}

class ShellSwapTest : public testing::Test {
 protected:
  // Swaps to `module` under `root`, keeping the answer in `answers_`.
  void Swap(const std::string& root,
            const std::string& module,
            ShellFiles files = ShellFiles::kDirectory) {
    swap_.Swap(base::FilePath(root), module, files,
               base::BindOnce(
                   [](std::vector<ShellOutcome>* answers, const ShellOutcome& ran) {
                     answers->push_back(ran);
                   },
                   &answers_));
  }

  // What the page served now says, with the serial its document names.
  void Heard(const ShellOutcome& ran) {
    swap_.Heard(base::NumberToString(source_.Serial()), ran);
  }

  // The module under its root that each load served.
  void Load() { loads_.push_back(source_.Root().Append(source_.Module())); }

  void Changed() { changed_at_.push_back(loads_.size()); }

  base::test::SingleThreadTaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  ShellSource source_{Serving("/run/splash", "splash.js")};
  std::vector<base::FilePath> loads_;
  std::vector<ShellOutcome> answers_;
  // How many loads had run each time the swap said the shell changed.
  std::vector<size_t> changed_at_;
  ShellSwap swap_{source_,
                  base::BindRepeating(&ShellSwapTest::Load,
                                      base::Unretained(this)),
                  base::BindRepeating(&ShellSwapTest::Changed,
                                      base::Unretained(this)),
                  kPatience};
};

TEST_F(ShellSwapTest, AnswersOnceTheNewShellRan) {
  Swap("/x/dist", "shell.js");
  EXPECT_THAT(loads_, ElementsAre(base::FilePath("/x/dist/shell.js")));
  EXPECT_TRUE(answers_.empty());

  Heard(std::nullopt);
  EXPECT_THAT(answers_, ElementsAre(std::nullopt));
  EXPECT_EQ(source_.Root(), base::FilePath("/x/dist"));
}

TEST_F(ShellSwapTest, GoesBackToTheOldShellWhenTheNewOneDidNotRun) {
  Swap("/x/dist", "shell.js");
  Heard(kWhy);

  EXPECT_THAT(loads_, ElementsAre(base::FilePath("/x/dist/shell.js"),
                                  base::FilePath("/run/splash/splash.js")));
  EXPECT_EQ(source_.Root(), base::FilePath("/run/splash"));
  EXPECT_EQ(source_.Module(), "splash.js");
  ASSERT_EQ(answers_.size(), 1u);
  ASSERT_TRUE(answers_[0].has_value());
  EXPECT_THAT(*answers_[0], HasSubstr(kWhy));
  EXPECT_THAT(*answers_[0], HasSubstr("/run/splash/splash.js"));
}

TEST_F(ShellSwapTest, GoesBackFromADevServerToTheFilesItReplaced) {
  // `domicile dev` on a shell that throws: the shell before comes back from
  // its directory, not from a socket path read as one.
  Swap("/run/user/1000/domicile-dev.sock", "@domicile/shell.js",
       ShellFiles::kDevServer);
  EXPECT_EQ(source_.Files(), ShellFiles::kDevServer);
  Heard(kWhy);

  EXPECT_EQ(source_.Root(), base::FilePath("/run/splash"));
  EXPECT_EQ(source_.Files(), ShellFiles::kDirectory);
}

TEST_F(ShellSwapTest, StaysOnTheSameShellReloadedWhenItDidNotRun) {
  // A rebuild in place: the old files are gone, so there is nothing to go
  // back to.
  Swap("/run/splash", "splash.js");
  Heard(kWhy);

  EXPECT_THAT(loads_, ElementsAre(base::FilePath("/run/splash/splash.js")));
  EXPECT_THAT(answers_, ElementsAre(std::make_optional<std::string>(kWhy)));
}

TEST_F(ShellSwapTest, SaysTheShellChangedBeforeLoadingAnother) {
  Swap("/x/dist", "shell.js");
  EXPECT_THAT(changed_at_, ElementsAre(0u));
}

// Going back is another change: the shell that did not run may have claimed.
TEST_F(ShellSwapTest, SaysTheShellChangedWhenGoingBack) {
  Swap("/x/dist", "shell.js");
  Heard(kWhy);
  EXPECT_THAT(changed_at_, ElementsAre(0u, 1u));
}

// A reload keeps its claims, so no chord reaches the focused window meanwhile.
TEST_F(ShellSwapTest, TheSameShellAgainIsNoChange) {
  Swap("/run/splash", "splash.js");
  EXPECT_TRUE(changed_at_.empty());
}

TEST_F(ShellSwapTest, TakesASilentShellAsLoadedAfterItsPatience) {
  Swap("/x/dist", "shell.js");
  task_environment_.FastForwardBy(kPatience);
  EXPECT_THAT(answers_, ElementsAre(std::nullopt));

  // Too late to go back: the supervisor was told it loaded.
  Heard(kWhy);
  EXPECT_EQ(source_.Root(), base::FilePath("/x/dist"));
  EXPECT_EQ(answers_.size(), 1u);
}

TEST_F(ShellSwapTest, IgnoresReportsWhileNoSwapWaits) {
  // The old shell's page coming back says it ran, and a reload may fail.
  Heard(kWhy);
  Heard(std::nullopt);
  EXPECT_TRUE(loads_.empty());
  EXPECT_EQ(source_.Root(), base::FilePath("/run/splash"));
}

TEST_F(ShellSwapTest, IgnoresThePageBeforeTheSwap) {
  // The page the swap replaces may run its module after the swap starts.
  const std::string before = base::NumberToString(source_.Serial());
  Swap("/x/dist", "shell.js");
  swap_.Heard(before, std::nullopt);
  EXPECT_TRUE(answers_.empty());

  Heard(kWhy);
  EXPECT_EQ(source_.Root(), base::FilePath("/run/splash"));
  EXPECT_EQ(answers_.size(), 1u);
}

TEST_F(ShellSwapTest, GoesBackPastASwapReplacedBeforeItRan) {
  Swap("/x/dist", "shell.js");
  Swap("/y/dist", "shell.js");
  ASSERT_EQ(answers_.size(), 1u);
  EXPECT_TRUE(answers_[0].has_value());

  Heard(kWhy);
  // Back to the shell that last ran, not the one never heard from.
  EXPECT_EQ(source_.Root(), base::FilePath("/run/splash"));
  EXPECT_EQ(answers_.size(), 2u);
}

TEST_F(ShellSwapTest, ReportsReachEveryListener) {
  ShellReports reports;
  std::vector<ShellOutcome> heard;
  reports.Listen(base::BindRepeating(
      [](std::vector<ShellOutcome>* heard, const std::string& serial,
         const ShellOutcome& ran) {
        EXPECT_EQ(serial, "3");
        heard->push_back(ran);
      },
      &heard));
  reports.Heard("3", kWhy);
  reports.Heard("3", std::nullopt);
  EXPECT_THAT(heard, ElementsAre(std::make_optional<std::string>(kWhy),
                                 std::nullopt));
}

}  // namespace
}  // namespace domicile
