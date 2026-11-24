// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_window.h"

#include <utility>

#include "third_party/blink/renderer/platform/heap/collection_support/heap_vector.h"

namespace blink {
namespace {

FrozenArray<DOMRectReadOnly>* RegionOf(const DomicileWindowState& state) {
  if (!state.pointer_region.has_value()) {
    return nullptr;
  }
  HeapVector<Member<DOMRectReadOnly>> boxes;
  for (const gfx::RectF& box : *state.pointer_region) {
    boxes.push_back(DOMRectReadOnly::FromRectF(box));
  }
  return MakeGarbageCollected<FrozenArray<DOMRectReadOnly>>(std::move(boxes));
}

}  // namespace

DomicileWindow::DomicileWindow(const DomicileWindowState& state)
    : state_(state), pointer_region_(RegionOf(state)) {}

DomicileWindow::~DomicileWindow() = default;

void DomicileWindow::Trace(Visitor* visitor) const {
  visitor->Trace(pointer_region_);
  ScriptWrappable::Trace(visitor);
}

}  // namespace blink
