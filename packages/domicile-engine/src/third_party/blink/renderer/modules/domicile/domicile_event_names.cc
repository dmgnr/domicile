// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_event_names.h"

#include "base/no_destructor.h"

namespace blink::domicile_event_names {

#define DOMICILE_DEFINE_EVENT_NAME(lower_name, function_name)        \
  const AtomicString& function_name() {                              \
    static const base::NoDestructor<AtomicString> name(#lower_name); \
    return *name;                                                    \
  }
DOMICILE_EVENT_NAMES(DOMICILE_DEFINE_EVENT_NAME)
#undef DOMICILE_DEFINE_EVENT_NAME

}  // namespace blink::domicile_event_names
