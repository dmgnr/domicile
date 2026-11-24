// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PAGE_CONTROL_H_
#define CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PAGE_CONTROL_H_

#include "components/domicile/browser/electron_app.h"
#include "components/domicile/browser/electron_page_call.h"

namespace domicile {

class ElectronPage;

// Carries out an app's page call, `method`, on `page`, and runs `done` once
// with what it gave or why it gave nothing. See electron_page_call.h.
void CallElectronPage(ElectronPage& page,
                      ElectronPageMethod method,
                      ElectronAnswer done);

}  // namespace domicile

#endif  // CHROME_BROWSER_DOMICILE_DOMICILE_ELECTRON_PAGE_CONTROL_H_
