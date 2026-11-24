// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_COMMON_DOMICILE_SCHEME_H_
#define COMPONENTS_DOMICILE_COMMON_DOMICILE_SCHEME_H_

namespace domicile {

// The scheme a Domicile shell is served over.
//
// Gives the shell a real origin without a TCP port, which any local process
// could reach. See docs/architecture/DOMICILE-SCHEME.md.
//
// Registered as a standard scheme so it has an origin, but neither web-safe
// nor CORS-enabled, so web content cannot navigate to it. Registered as
// supporting the Fetch API, so a document can fetch() its own files;
// ShellURLLoaderFactory serves them only to their own origin.
inline constexpr char kDomicileScheme[] = "domicile";

// The shell's host. The bare root `domicile://shell/` is a page that
// `ShellURLLoaderFactory` generates, not a file on disk. Requests to hosts
// other than this, `kDomicileHomeHost` and an app's are refused.
inline constexpr char kDomicileShellHost[] = "shell";

// The user's home, for shell previews: `domicile://home/Notes/a.png` is
// `$HOME/Notes/a.png`. Served only to the shell's own document (see
// ShellURLLoaderFactory) and never for paths containing a dotfile.
inline constexpr char kDomicileHomeHost[] = "home";

// An app module's host starts with this, followed by an id from its root:
// `domicile://app-3f34b27d8967e876d882c16c62df92be/`. Served only for an app
// `run_app` added. See components/domicile/browser/app_roots.h and
// docs/architecture/APP-MODULES.md.
inline constexpr char kDomicileAppHostPrefix[] = "app-";

// Directory the shell's files are read from.
inline constexpr char kDomicileShellRootSwitch[] = "domicile-shell-root";

// Present when --domicile-shell-root names a dev server's unix socket rather
// than a directory: `domicile dev` serves the shell with hot module
// replacement. See components/domicile/browser/shell_dev_server.h.
inline constexpr char kDomicileShellDevServerSwitch[] =
    "domicile-shell-dev-server";

// The compositor's control socket (its --chrome-socket): a unix stream of
// newline-delimited JSON.
inline constexpr char kDomicileControlSocketSwitch[] =
    "domicile-control-socket";

// The engine's command socket: a unix stream the engine binds and the
// supervisor dials, one line of JSON in and one out. See
// `components/domicile/browser/command_protocol.h`.
//
// It talks to the supervisor, not the compositor, because the page never uses
// these messages. Absent unless `domicile load-shell` started the engine.
inline constexpr char kDomicileCommandSocketSwitch[] =
    "domicile-command-socket";

// The engine's Electron socket: a unix stream the engine binds and each
// `electron-host` dials, one connection per running Electron app, JSON lines
// both ways. See `components/domicile/browser/electron_protocol.h`. Absent
// unless the supervisor passes it.
inline constexpr char kDomicileElectronSocketSwitch[] =
    "domicile-electron-socket";

// Path to the shell's JavaScript module. There is no manifest: the shell
// provides everything through its exports once running.
inline constexpr char kDomicileShellModuleSwitch[] = "domicile-shell-module";

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_COMMON_DOMICILE_SCHEME_H_
