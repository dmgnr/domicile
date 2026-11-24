// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef COMPONENTS_DOMICILE_BROWSER_PAGE_MATCHES_H_
#define COMPONENTS_DOMICILE_BROWSER_PAGE_MATCHES_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "base/values.h"

namespace domicile {

// How a shell counts, and clicks, the elements in a <webview>'s page that
// match a CSS selector. See WebViewGuest.CountMatches and ClickMatch in
// components/domicile/mojom/web_view_guest.mojom.

// The script that counts `selector`'s matches in the page's document. The
// selector is a JSON string literal in it, so no selector can end the call
// and run script of its own.
std::u16string CountMatchesScript(std::string_view selector);

// The count the script answered with, or nothing when it threw or the page
// went before it ran: either way the result is not a number.
std::optional<int32_t> CountFrom(const base::Value& result);

// The script that clicks the first shown element in the page's document
// matching `selector` (what checkVisibility() says shows), as a press of the
// mouse's main button on its middle does: it scrolls the element into view,
// then sends it pointerdown, mousedown, pointerup, mouseup and click. Answers
// whether an element matched. The selector is a JSON string literal in it, as
// in CountMatchesScript.
std::u16string ClickMatchScript(std::string_view selector);

// Whether the click script found an element to click, or nothing when it
// threw or the page went before it ran.
std::optional<bool> ClickedFrom(const base::Value& result);

}  // namespace domicile

#endif  // COMPONENTS_DOMICILE_BROWSER_PAGE_MATCHES_H_
