// Copyright 2026 Tom Mecattaf
// SPDX-License-Identifier: MIT

#include "ui/events/ozone/evdev/domicile/libinput_keyboard_event_converter.h"

#include <libinput.h>
#include <linux/input.h>

#include <utility>

#include "base/check.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/logging.h"
#include "base/numerics/safe_conversions.h"
#include "ui/events/ozone/evdev/domicile/libinput_seat.h"

namespace ui {
std::unique_ptr<LibInputKeyboardEventConverter>
LibInputKeyboardEventConverter::Create(LibInputSeat& seat,
                                       base::ScopedFD fd,
                                       const base::FilePath& path,
                                       int id,
                                       const EventDeviceInfo& info,
                                       CursorDelegateEvdev* cursor,
                                       DeviceEventDispatcherEvdev* dispatcher) {
  const auto device = seat.AddDevice(fd, path);
  if (!device.has_value()) {
    LOG(ERROR) << "libinput " << info.name() << " (" << path
               << "): " << device.error();
    return nullptr;
  }
  return std::make_unique<LibInputKeyboardEventConverter>(
      seat, std::move(fd), *device, path, id, info, cursor, dispatcher);
}

LibInputKeyboardEventConverter::LibInputKeyboardEventConverter(
    LibInputSeat& seat,
    base::ScopedFD fd,
    libinput_device* device,
    const base::FilePath& path,
    int id,
    const EventDeviceInfo& info,
    CursorDelegateEvdev* cursor,
    DeviceEventDispatcherEvdev* dispatcher)
    : EventConverterEvdevImpl(std::move(fd),
                              path,
                              id,
                              info,
                              cursor,
                              dispatcher),
      seat_(seat),
      device_(device) {
  CHECK(device_);
}

LibInputKeyboardEventConverter::~LibInputKeyboardEventConverter() {
  Stop();
  SetEnabled(false);
  seat_->RemoveDevice(device_.ExtractAsDangling());
}

void LibInputKeyboardEventConverter::Start() {
  CHECK(device_);
  CHECK(!watching_);
  // The seat clears this callback before the converter releases its device.
  seat_->SetEventHandler(
      device_, base::BindRepeating(&LibInputKeyboardEventConverter::HandleEvent,
                                   base::Unretained(this)));
  watching_ = true;
}

void LibInputKeyboardEventConverter::Stop() {
  if (watching_) {
    seat_->SetEventHandler(device_, base::NullCallback());
    watching_ = false;
  }
}

void LibInputKeyboardEventConverter::SetTypingGuard(TypingGuard* guard) {
  EventConverterEvdevImpl::SetTypingGuard(guard);
}

void LibInputKeyboardEventConverter::HandleEvent(libinput_event* event) {
  if (IsEnabled() &&
      libinput_event_get_type(event) == LIBINPUT_EVENT_KEYBOARD_KEY) {
    auto* keyboard = libinput_event_get_keyboard_event(event);
    const input_event key = LibInputKeyboardKey(
        libinput_event_keyboard_get_key(keyboard),
        libinput_event_keyboard_get_key_state(keyboard) ==
            LIBINPUT_KEY_STATE_PRESSED,
        base::TimeTicks() +
            base::Microseconds(
                libinput_event_keyboard_get_time_usec(keyboard)));
    ProcessEvents(base::span_from_ref(key));
  }
}

input_event LibInputKeyboardKey(unsigned key,
                                bool down,
                                base::TimeTicks timestamp) {
  const base::TimeDelta elapsed = timestamp - base::TimeTicks();
  input_event input{};
  input.time.tv_sec = elapsed.InSeconds();
  input.time.tv_usec =
      (elapsed - base::Seconds(elapsed.InSeconds())).InMicroseconds();
  input.type = EV_KEY;
  input.code = base::checked_cast<decltype(input.code)>(key);
  input.value = down;
  return input;
}

}  // namespace ui
