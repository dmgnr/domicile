// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SHELL_SOURCE_H_
#define COMPONENTS_DOMICILE_BROWSER_SHELL_SOURCE_H_

#include <cstdint>
#include <string>

#include "base/files/file_path.h"

namespace base {
class CommandLine;
}  // namespace base

namespace domicile {

// Where a shell's files come from.
enum class ShellFiles {
  // Files under the root, a directory.
  kDirectory,
  // A dev server listening on the root, a unix socket: `domicile dev` serves
  // the shell with hot module replacement. See shell_dev_server.h.
  kDevServer,
};

// The shell this browser serves: its root directory and module.
//
// Seeded from `--domicile-shell-root`, `--domicile-shell-module` and
// `--domicile-shell-dev-server`, and
// mutable so `domicile load-shell` can switch shells without restarting the
// engine, which would close every window. See
// docs/architecture/THE-DOMICILE-BINARY.md#the-engine-command-socket.
//
// Not thread-safe: read and write it only on the UI thread.
class ShellSource {
 public:
  // The process-wide instance, seeded from the command line on first use.
  static ShellSource& Get();

  explicit ShellSource(const base::CommandLine& command_line);

  ShellSource(const ShellSource&) = delete;
  ShellSource& operator=(const ShellSource&) = delete;

  ~ShellSource();

  // The directory the shell's files are read from, or the dev server's
  // socket (see `Files()`). Empty if never set, which makes
  // ShellURLLoaderFactory refuse every request.
  base::FilePath Root() const;

  // Whether `Root()` is a directory or a dev server's socket.
  ShellFiles Files() const;

  // The shell's module, relative to `Root()`. Empty if never set, which makes
  // the shell document fail with an error.
  std::string Module() const;

  // Replaces the shell. Set all three together: a module only makes sense
  // with its root. Takes effect on the next navigation or reload of the
  // shell's window.
  void Set(const base::FilePath& root,
           const std::string& module,
           ShellFiles files);

  // Counts each Set, so a shell document can be told apart from one served
  // before the last Set. The document names it, and its page reports it back
  // to ShellSwap.
  uint64_t Serial() const;

 private:
  base::FilePath root_;
  std::string module_;
  ShellFiles files_;
  uint64_t serial_ = 0;
};

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SHELL_SOURCE_H_
