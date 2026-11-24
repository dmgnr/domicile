// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/page_matches.h"

#include "base/json/string_escape.h"
#include "base/strings/strcat.h"
#include "base/strings/utf_string_conversions.h"

namespace domicile {

std::u16string CountMatchesScript(std::string_view selector) {
  return base::UTF8ToUTF16(
      base::StrCat({"document.querySelectorAll(",
                    base::GetQuotedJSONString(selector), ").length"}));
}

std::optional<int32_t> CountFrom(const base::Value& result) {
  return result.is_int() ? std::make_optional(result.GetInt()) : std::nullopt;
}

std::u16string ClickMatchScript(std::string_view selector) {
  return base::UTF8ToUTF16(base::StrCat(
      {"((selector) => {"
       "const element = [...document.querySelectorAll(selector)]"
       ".find((each) => each.checkVisibility());"
       "if (element === undefined) { return false; }"
       "element.scrollIntoView({ block: 'nearest', inline: 'nearest' });"
       "const box = element.getBoundingClientRect();"
       "const at = { bubbles: true, cancelable: true, composed: true,"
       " button: 0, clientX: box.left + box.width / 2,"
       " clientY: box.top + box.height / 2 };"
       "const pointer = { ...at, isPrimary: true, pointerId: 1,"
       " pointerType: 'mouse' };"
       "element.dispatchEvent(new PointerEvent('pointerdown',"
       " { ...pointer, buttons: 1 }));"
       "element.dispatchEvent(new MouseEvent('mousedown',"
       " { ...at, buttons: 1 }));"
       "element.dispatchEvent(new PointerEvent('pointerup', pointer));"
       "element.dispatchEvent(new MouseEvent('mouseup', at));"
       "element.dispatchEvent(new MouseEvent('click', at));"
       "return true;"
       "})(",
       base::GetQuotedJSONString(selector), ")"}));
}

std::optional<bool> ClickedFrom(const base::Value& result) {
  return result.is_bool() ? std::make_optional(result.GetBool()) : std::nullopt;
}

}  // namespace domicile
