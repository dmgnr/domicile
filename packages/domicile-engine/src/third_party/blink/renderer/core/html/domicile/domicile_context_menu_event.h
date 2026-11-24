// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_DOMICILE_CONTEXT_MENU_EVENT_H_
#define THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_DOMICILE_CONTEXT_MENU_EVENT_H_

#include <cstdint>

#include "components/domicile/mojom/web_view_guest.mojom-blink.h"
#include "third_party/blink/renderer/core/core_export.h"
#include "third_party/blink/renderer/core/dom/events/event.h"
#include "third_party/blink/renderer/platform/heap/member.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace blink {

class ExceptionState;
class HTMLWebViewElement;

// A context menu for the shell to draw: what was under the click, and `run()`
// to do an item's browser-side action on this menu's link, image and click.
//
// The browser keeps only the newest menu, so `run()` on a replaced menu throws
// InvalidStateError.
class CORE_EXPORT DomicileContextMenuEvent final : public Event {
  DEFINE_WRAPPERTYPEINFO();

 public:
  DomicileContextMenuEvent(const AtomicString& type,
                           domicile::mojom::blink::WebViewContextMenuPtr menu,
                           HTMLWebViewElement& owner);
  ~DomicileContextMenuEvent() override;

  int32_t id() const { return menu_->id; }

  int32_t x() const { return menu_->x; }
  int32_t y() const { return menu_->y; }
  String linkUrl() const;
  const String& linkText() const { return menu_->link_text; }
  String srcUrl() const;
  String mediaType() const;
  bool hasImageContents() const { return menu_->has_image_contents; }
  bool canPictureInPicture() const { return menu_->can_picture_in_picture; }
  bool inPictureInPicture() const { return menu_->in_picture_in_picture; }
  const String& selectionText() const { return menu_->selection_text; }
  bool isEditable() const { return menu_->is_editable; }
  bool canUndo() const { return menu_->can_undo; }
  bool canRedo() const { return menu_->can_redo; }
  bool canCut() const { return menu_->can_cut; }
  bool canCopy() const { return menu_->can_copy; }
  bool canPaste() const { return menu_->can_paste; }
  bool canDelete() const { return menu_->can_delete; }
  bool canSelectAll() const { return menu_->can_select_all; }
  const String& misspelledWord() const { return menu_->misspelled_word; }
  const Vector<String>& spellingSuggestions() const {
    return menu_->spelling_suggestions;
  }

  void run(const String& action, ExceptionState&);
  void replaceMisspelling(const String& word, ExceptionState&);

  const AtomicString& InterfaceName() const override;

  void Trace(Visitor*) const override;

 private:
  // Whether this menu offers `action`. Mirrors Offers in
  // components/domicile/browser/context_menu.h so the shell gets an exception
  // instead of the browser a bad message.
  bool Offers(domicile::mojom::blink::WebViewContextMenuAction action) const;

  domicile::mojom::blink::WebViewContextMenuPtr menu_;
  // What `run()` asks.
  Member<HTMLWebViewElement> owner_;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_CORE_HTML_DOMICILE_DOMICILE_CONTEXT_MENU_EVENT_H_
