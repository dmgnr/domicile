// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_AGENT_DEVTOOLS_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_AGENT_DEVTOOLS_H_

#include <string>

#include "base/values.h"
#include "components/domicile/browser/command_protocol.h"

namespace domicile {

// Carries out the command protocol's `devtools`: sends one DevTools Protocol
// method to browser window `window`'s page for an agent, and answers with its
// result. Refuses a window that is not open or is private. Attaches a client
// of its own for the one method and detaches once answered, so DevTools the
// user has open on the page keeps working.
void SendDevToolsToBrowserWindow(const std::string& window,
                                 const std::string& method,
                                 base::DictValue params,
                                 DevToolsAnswered answered);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_AGENT_DEVTOOLS_H_
