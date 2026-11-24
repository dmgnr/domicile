// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_CONTEXT_MENU_H_
#define COMPONENTS_DOMICILE_BROWSER_CONTEXT_MENU_H_

#include "components/domicile/browser/electron_protocol.h"
#include "components/domicile/mojom/web_view_guest.mojom.h"

namespace content {
struct ContextMenuParams;
}  // namespace content

namespace gfx {
class Point;
}  // namespace gfx

namespace domicile {

// Conversions for the context menu a <webview> hands its shell. See
// WebViewGuest::HandleContextMenu. Separate from the guest so they can be unit
// tested.

// `params` as menu `id`, with the click at `in_page` (CSS pixels from the top
// left of the page's box).
mojom::WebViewContextMenuPtr AsWebViewContextMenu(
    int id,
    const content::ContextMenuParams& params,
    const gfx::Point& in_page);

// Whether a menu over `params` offers `action`. A link action needs a link,
// an image action an image. The element checks first, so a request for one
// not offered is a bad message.
bool Offers(const content::ContextMenuParams& params,
            mojom::WebViewContextMenuAction action);

// Whether a menu over `params` is over a misspelled word, which
// WebViewGuest::ReplaceMisspelling replaces. As Offers, the element checks
// first.
bool OffersSpellingFixes(const content::ContextMenuParams& params);

// `params` as an Electron app's webContents hears it in `context-menu`, with
// the click at `in_page`.
ElectronContextMenu AsElectronContextMenu(
    const content::ContextMenuParams& params,
    const gfx::Point& in_page);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_CONTEXT_MENU_H_
