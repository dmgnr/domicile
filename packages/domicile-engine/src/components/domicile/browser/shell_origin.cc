// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/shell_origin.h"

#include "components/domicile/browser/app_roots.h"
#include "components/domicile/common/domicile_scheme.h"
#include "url/origin.h"

namespace domicile {

bool IsShellOrigin(const url::Origin& origin) {
  return origin.scheme() == kDomicileScheme &&
         origin.host() == kDomicileShellHost;
}

bool IsCrossOriginIsolatedOrigin(const url::Origin& origin) {
  return IsShellOrigin(origin) || (origin.scheme() == kDomicileScheme &&
                                   IsAppHost(origin.host()));
}

}  // namespace domicile
