// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_source.h"

#include <string>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "components/domicile/common/domicile_scheme.h"

namespace domicile {

// static
ShellSource& ShellSource::Get() {
  static base::NoDestructor<ShellSource> source(
      *base::CommandLine::ForCurrentProcess());
  return *source;
}

ShellSource::ShellSource(const base::CommandLine& command_line)
    : root_(command_line.GetSwitchValuePath(kDomicileShellRootSwitch)),
      module_(command_line.GetSwitchValueASCII(kDomicileShellModuleSwitch)),
      files_(command_line.HasSwitch(kDomicileShellDevServerSwitch)
                 ? ShellFiles::kDevServer
                 : ShellFiles::kDirectory) {}

ShellSource::~ShellSource() = default;

base::FilePath ShellSource::Root() const {
  return root_;
}

std::string ShellSource::Module() const {
  return module_;
}

ShellFiles ShellSource::Files() const {
  return files_;
}

void ShellSource::Set(const base::FilePath& root,
                      const std::string& module,
                      ShellFiles files) {
  root_ = root;
  module_ = module;
  files_ = files;
  ++serial_;
}

uint64_t ShellSource::Serial() const {
  return serial_;
}

}  // namespace domicile
