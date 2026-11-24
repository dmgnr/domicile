// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CONTENT_PUBLIC_BROWSER_DOMICILE_LOG_LEVELS_H_
#define CONTENT_PUBLIC_BROWSER_DOMICILE_LOG_LEVELS_H_

#include <string>

#include "content/common/content_export.h"

namespace content {

// Logs at `min_level` (0 INFO to 3 FATAL) and VLOGs at `vmodule` in the
// browser and every child process, and in those started later, until the
// engine exits. For `domicile set-log-level`. UI thread only.
CONTENT_EXPORT void SetDomicileLogLevels(int min_level,
                                         const std::string& vmodule);

}  // namespace content

#endif  // CONTENT_PUBLIC_BROWSER_DOMICILE_LOG_LEVELS_H_
