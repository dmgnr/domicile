// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "third_party/blink/renderer/modules/domicile/domicile_app_host.h"

#include "base/no_destructor.h"
#include "third_party/blink/renderer/core/events/message_event.h"
#include "third_party/blink/renderer/core/frame/local_dom_window.h"
#include "third_party/blink/renderer/core/frame/local_frame.h"
#include "third_party/blink/renderer/platform/bindings/exception_code.h"

namespace blink {

DomicileAppHost::DomicileAppHost(LocalDOMWindow& window)
    : window_(&window), channel_(&window), client_receiver_(this, &window) {}

DomicileAppHost::~DomicileAppHost() = default;

bool DomicileAppHost::EnsureBound() {
  if (channel_.is_bound()) {
    return true;
  }
  if (!window_ || !window_->GetFrame()) {
    return false;
  }
  auto task_runner = window_->GetTaskRunner(TaskType::kInternalDefault);
  window_->GetBrowserInterfaceBroker().GetInterface(
      channel_.BindNewPipeAndPassReceiver(task_runner));
  // The other direction in the same breath, as DomicileHost does: a channel
  // bound without a client drops every answer.
  channel_->SetClient(client_receiver_.BindNewPipeAndPassRemote(task_runner));
  return true;
}

void DomicileAppHost::callSystem(ScriptState*,
                                 uint32_t id,
                                 const String& request,
                                 ExceptionState& exception_state) {
  if (!EnsureBound()) {
    exception_state.ThrowDOMException(
        DOMExceptionCode::kInvalidStateError,
        "There is no desktop for this app to call.");
    return;
  }
  channel_->CallSystem(id, request);
}

// A standard MessageEvent, as DomicileHost::System builds one, so the SDK's
// `system()` reads either host.
void DomicileAppHost::System(const String& message) {
  MessageEvent* event = MessageEvent::Create();
  event->initMessageEvent(domicile_event_names::System(), /*bubbles=*/false,
                          /*cancelable=*/false, message, /*origin=*/nullptr,
                          /*last_event_id=*/String(), /*source=*/nullptr,
                          /*ports=*/nullptr);
  DispatchEvent(*event);
}

// Not in event_target_names.json5, for domicile_event_names.h's reason: that
// header is included across Blink.
const AtomicString& DomicileAppHost::InterfaceName() const {
  static const base::NoDestructor<AtomicString> name("DomicileAppHost");
  return *name;
}

ExecutionContext* DomicileAppHost::GetExecutionContext() const {
  return window_.Get();
}

void DomicileAppHost::Trace(Visitor* visitor) const {
  visitor->Trace(window_);
  visitor->Trace(channel_);
  visitor->Trace(client_receiver_);
  EventTarget::Trace(visitor);
}

}  // namespace blink
