// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_SHELL_ORIGIN_H_
#define COMPONENTS_DOMICILE_BROWSER_SHELL_ORIGIN_H_

namespace url {
class Origin;
}

namespace domicile {

// Whether `origin` is the shell's, `domicile://shell`.
//
// Gates what only the shell may do, such as embed a client's window. Web
// content cannot hold this origin: see docs/architecture/DOMICILE-SCHEME.md.
bool IsShellOrigin(const url::Origin& origin);

// Whether `origin` is the shell's or an app module's, `domicile://app-<id>`.
//
// These run as programs, so the engine makes them cross-origin isolated with
// no COOP or COEP: they get SharedArrayBuffer, and what they load is not
// checked for CORP. See docs/architecture/DOMICILE-SCHEME.md.
bool IsCrossOriginIsolatedOrigin(const url::Origin& origin);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_SHELL_ORIGIN_H_
