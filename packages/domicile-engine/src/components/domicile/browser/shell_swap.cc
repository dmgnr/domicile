// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_swap.h"

#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"

namespace domicile {

// static
ShellReports& ShellReports::Get() {
  static base::NoDestructor<ShellReports> reports;
  return *reports;
}

ShellReports::ShellReports() = default;
ShellReports::~ShellReports() = default;

void ShellReports::Listen(Listener heard) {
  base::AutoLock held(lock_);
  listeners_.push_back(std::move(heard));
}

void ShellReports::Heard(const std::string& serial, const ShellOutcome& ran) {
  // Run outside the lock, since a listener may re-enter this.
  std::vector<Listener> tell;
  {
    base::AutoLock held(lock_);
    tell = listeners_;
  }
  for (const Listener& heard : tell) {
    heard.Run(serial, ran);
  }
}

ShellSwap::ShellSwap(ShellSource& source,
                     base::RepeatingClosure load,
                     base::RepeatingClosure changed,
                     base::TimeDelta patience)
    : source_(source),
      load_(std::move(load)),
      changed_(std::move(changed)),
      patience_(patience) {}

ShellSwap::~ShellSwap() = default;

void ShellSwap::Swap(const base::FilePath& root,
                     const std::string& module,
                     ShellFiles files,
                     Swapped swapped) {
  if (swapped_.is_null()) {
    previous_ = {.root = source_->Root(),
                 .module = source_->Module(),
                 .files = source_->Files()};
  } else {
    std::move(swapped_).Run(
        "domicile load-shell loaded another shell before this one ran");
  }
  swapped_ = std::move(swapped);
  Serve({.root = root, .module = module, .files = files});
  patience_timer_.Start(FROM_HERE, patience_,
                        base::BindOnce(&ShellSwap::Answer,
                                       base::Unretained(this), ShellOutcome()));
}

void ShellSwap::Heard(const std::string& serial, const ShellOutcome& ran) {
  if (swapped_.is_null() ||
      serial != base::NumberToString(source_->Serial())) {
    return;
  }
  if (!ran.has_value() || (previous_.root == source_->Root() &&
                            previous_.module == source_->Module() &&
                            previous_.files == source_->Files())) {
    Answer(ran);
    return;
  }
  Serve(previous_);
  Answer(base::StrCat({*ran, "\nThe desktop is back on the shell it had, ",
                       previous_.root.Append(previous_.module).value(), "."}));
}

void ShellSwap::Serve(const Served& shell) {
  if (shell.root != source_->Root() || shell.module != source_->Module()) {
    changed_.Run();
  }
  source_->Set(shell.root, shell.module, shell.files);
  load_.Run();
}

void ShellSwap::Answer(const ShellOutcome& ran) {
  patience_timer_.Stop();
  std::move(swapped_).Run(ran);
}

}  // namespace domicile
