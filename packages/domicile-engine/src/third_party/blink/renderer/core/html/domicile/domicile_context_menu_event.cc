// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/core/html/domicile/domicile_context_menu_event.h"

#include <optional>
#include <utility>

#include "third_party/blink/renderer/core/event_interface_names.h"
#include "third_party/blink/renderer/core/html/domicile/html_web_view_element.h"
#include "third_party/blink/renderer/platform/bindings/exception_state.h"

namespace blink {

namespace {

using domicile::mojom::blink::WebViewContextMenuAction;
using domicile::mojom::blink::WebViewMediaType;

// The actions `run()` takes. packages/chrome-sdk/src/webview-element.ts lists
// the same names.
std::optional<WebViewContextMenuAction> ActionNamed(const String& name) {
  if (name == "undo") {
    return WebViewContextMenuAction::kUndo;
  } else if (name == "redo") {
    return WebViewContextMenuAction::kRedo;
  } else if (name == "cut") {
    return WebViewContextMenuAction::kCut;
  } else if (name == "copy") {
    return WebViewContextMenuAction::kCopy;
  } else if (name == "paste") {
    return WebViewContextMenuAction::kPaste;
  } else if (name == "paste-and-match-style") {
    return WebViewContextMenuAction::kPasteAndMatchStyle;
  } else if (name == "delete") {
    return WebViewContextMenuAction::kDelete;
  } else if (name == "select-all") {
    return WebViewContextMenuAction::kSelectAll;
  } else if (name == "copy-link-address") {
    return WebViewContextMenuAction::kCopyLinkAddress;
  } else if (name == "save-link-as") {
    return WebViewContextMenuAction::kSaveLinkAs;
  } else if (name == "copy-image") {
    return WebViewContextMenuAction::kCopyImage;
  } else if (name == "copy-media-address") {
    return WebViewContextMenuAction::kCopyMediaAddress;
  } else if (name == "save-media-as") {
    return WebViewContextMenuAction::kSaveMediaAs;
  } else if (name == "picture-in-picture") {
    return WebViewContextMenuAction::kPictureInPicture;
  } else if (name == "inspect") {
    return WebViewContextMenuAction::kInspect;
  } else if (name == "add-to-dictionary") {
    return WebViewContextMenuAction::kAddToDictionary;
  } else {
    return std::nullopt;
  }
}

}  // namespace

// Bubbles, like the element's other events. Not cancelable: there is no
// browser menu to prevent.
DomicileContextMenuEvent::DomicileContextMenuEvent(
    const AtomicString& type,
    domicile::mojom::blink::WebViewContextMenuPtr menu,
    HTMLWebViewElement& owner)
    : Event(type, Bubbles::kYes, Cancelable::kNo),
      menu_(std::move(menu)),
      owner_(&owner) {}

DomicileContextMenuEvent::~DomicileContextMenuEvent() = default;

String DomicileContextMenuEvent::linkUrl() const {
  return menu_->link_url.IsEmpty() ? String("") : menu_->link_url.GetString();
}

String DomicileContextMenuEvent::srcUrl() const {
  return menu_->src_url.IsEmpty() ? String("") : menu_->src_url.GetString();
}

// No default arm, so a type added to the mojom fails the build.
String DomicileContextMenuEvent::mediaType() const {
  switch (menu_->media_type) {
    case WebViewMediaType::kNone:
      return "none";
    case WebViewMediaType::kImage:
      return "image";
    case WebViewMediaType::kVideo:
      return "video";
    case WebViewMediaType::kAudio:
      return "audio";
    case WebViewMediaType::kCanvas:
      return "canvas";
    case WebViewMediaType::kFile:
      return "file";
    case WebViewMediaType::kPlugin:
      return "plugin";
  }
}

void DomicileContextMenuEvent::run(const String& action,
                                   ExceptionState& exception_state) {
  const std::optional<WebViewContextMenuAction> named = ActionNamed(action);
  if (!named.has_value()) {
    exception_state.ThrowTypeError("That is not a context menu action.");
    return;
  }
  if (!Offers(*named)) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kNotSupportedError,
        "This context menu does not offer that action.");
    return;
  }
  owner_->RunContextMenuAction(*this, *named, exception_state);
}

void DomicileContextMenuEvent::replaceMisspelling(
    const String& word,
    ExceptionState& exception_state) {
  if (menu_->misspelled_word.empty()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kNotSupportedError,
        "This context menu is not over a misspelled word.");
    return;
  }
  owner_->ReplaceMisspelling(*this, word, exception_state);
}

bool DomicileContextMenuEvent::Offers(WebViewContextMenuAction action) const {
  const bool has_pixels = (menu_->media_type == WebViewMediaType::kImage ||
                           menu_->media_type == WebViewMediaType::kCanvas) &&
                          menu_->has_image_contents;
  const bool has_source = (menu_->media_type == WebViewMediaType::kImage ||
                           menu_->media_type == WebViewMediaType::kVideo ||
                           menu_->media_type == WebViewMediaType::kAudio) &&
                          menu_->src_url.IsValid();
  switch (action) {
    case WebViewContextMenuAction::kUndo:
    case WebViewContextMenuAction::kRedo:
    case WebViewContextMenuAction::kCut:
    case WebViewContextMenuAction::kCopy:
    case WebViewContextMenuAction::kPaste:
    case WebViewContextMenuAction::kPasteAndMatchStyle:
    case WebViewContextMenuAction::kDelete:
    case WebViewContextMenuAction::kSelectAll:
    case WebViewContextMenuAction::kInspect:
      return true;
    case WebViewContextMenuAction::kCopyLinkAddress:
    case WebViewContextMenuAction::kSaveLinkAs:
      return menu_->link_url.IsValid();
    case WebViewContextMenuAction::kCopyImage:
      return has_pixels;
    case WebViewContextMenuAction::kCopyMediaAddress:
      return has_source;
    case WebViewContextMenuAction::kSaveMediaAs:
      return has_pixels || has_source;
    case WebViewContextMenuAction::kPictureInPicture:
      return menu_->can_picture_in_picture;
    case WebViewContextMenuAction::kAddToDictionary:
      return !menu_->misspelled_word.empty();
  }
}

const AtomicString& DomicileContextMenuEvent::InterfaceName() const {
  return event_interface_names::kDomicileContextMenuEvent;
}

void DomicileContextMenuEvent::Trace(Visitor* visitor) const {
  visitor->Trace(owner_);
  Event::Trace(visitor);
}

}  // namespace blink
