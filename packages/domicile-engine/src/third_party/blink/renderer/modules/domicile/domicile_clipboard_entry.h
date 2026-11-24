// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_CLIPBOARD_ENTRY_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_CLIPBOARD_ENTRY_H_

#include "third_party/blink/renderer/modules/modules_export.h"
#include "third_party/blink/renderer/platform/bindings/script_wrappable.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace blink {

// One thing that was copied, as the compositor described it.
//
// A ScriptWrappable rather than a dictionary, for DomicileDisplay's reason:
// WebIDL will not have a dictionary as the element type of an attribute's
// array, and these are read off DomicileHost.clipboard.
//
// Immutable, and cheap to replace: the compositor sends the whole history
// whenever any of it changes, because a copy re-orders the list as often as it
// adds to it and a page reconciling deltas could be wrong about the order
// forever after missing one.
class MODULES_EXPORT DomicileClipboardEntry final : public ScriptWrappable {
  DEFINE_WRAPPERTYPEINFO();

 public:
  DomicileClipboardEntry(uint32_t id,
                         bool image,
                         const String& preview,
                         const String& thumbnail,
                         bool current);
  ~DomicileClipboardEntry() override;

  uint32_t id() const { return id_; }
  bool image() const { return image_; }
  const String& preview() const { return preview_; }
  const String& thumbnail() const { return thumbnail_; }
  bool current() const { return current_; }

  void Trace(Visitor*) const override;

 private:
  // What DomicileHost::copyClipboardEntry names this row by. Never reused, so
  // an id a page is holding either names the row it was told about or names
  // nothing at all.
  uint32_t id_ = 0;
  // An image with no text, whose preview names its size or format.
  bool image_ = false;
  // Enough of what was copied to recognize it by, and not necessarily all of
  // it: the compositor cuts a long copy down to a row. What goes back on the
  // clipboard is always the whole thing.
  String preview_;
  // A small picture of an image with no text, as a PNG `data:` URL, or empty.
  String thumbnail_;
  // What the clipboard holds.
  bool current_ = false;
};

}  // namespace blink

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_DOMICILE_DOMICILE_CLIPBOARD_ENTRY_H_
