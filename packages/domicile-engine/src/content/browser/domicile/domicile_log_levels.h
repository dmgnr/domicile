// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CONTENT_BROWSER_DOMICILE_DOMICILE_LOG_LEVELS_H_
#define CONTENT_BROWSER_DOMICILE_DOMICILE_LOG_LEVELS_H_

#include "content/common/child_process.mojom.h"

namespace content {

// Sends a child process just started the levels SetDomicileLogLevels last
// set. Nothing when they were never set: the child has the browser's
// switches. See content/public/browser/domicile_log_levels.h.
void SendDomicileLogLevels(mojom::ChildProcess& child);

}  // namespace content

#endif  // CONTENT_BROWSER_DOMICILE_DOMICILE_LOG_LEVELS_H_
