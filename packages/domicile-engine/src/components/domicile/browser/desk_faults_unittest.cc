// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/desk_faults.h"

#include <string>

#include "base/functional/bind.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace domicile {
namespace {

// One compositor hears it once, though each monitor's page has a channel.
TEST(DeskFaultsTest, OnlyTheFirstListenerHearsAFault) {
  DeskFaults faults;
  std::string first;
  int second = 0;
  faults.AddListener(base::BindRepeating(
      [](std::string* heard, const std::string& what) { *heard = what; },
      base::Unretained(&first)));
  faults.AddListener(
      base::BindRepeating([](int* heard, const std::string&) { ++*heard; },
                          base::Unretained(&second)));

  faults.Report("A page stayed in fullscreen.");

  EXPECT_EQ(first, "A page stayed in fullscreen.");
  EXPECT_EQ(second, 0);
}

// A closed channel is not told, or it would run on a deleted page's channel;
// the next one is.
TEST(DeskFaultsTest, ARemovedListenerHandsOnToTheNext) {
  DeskFaults faults;
  int removed = 0;
  int kept = 0;
  const DeskFaults::ListenerId listener = faults.AddListener(
      base::BindRepeating([](int* count, const std::string&) { ++*count; },
                          base::Unretained(&removed)));
  faults.AddListener(
      base::BindRepeating([](int* count, const std::string&) { ++*count; },
                          base::Unretained(&kept)));

  faults.RemoveListener(listener);
  faults.Report("A page stayed in fullscreen.");

  EXPECT_EQ(removed, 0);
  EXPECT_EQ(kept, 1);
}

}  // namespace
}  // namespace domicile
