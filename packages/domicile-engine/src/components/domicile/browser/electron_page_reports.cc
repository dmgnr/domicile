// Copyright 2026 Connor Prussin
// SPDX-License-Identifier: MIT

#include "components/domicile/browser/electron_page_reports.h"

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/check.h"
#include "base/check_op.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/types/expected.h"
#include "base/types/expected_macros.h"
#include "base/values.h"

namespace domicile {
namespace {

// The visitor of std::visit's lambdas, one per alternative.
template <typename... Lambdas>
struct Overloaded : Lambdas... {
  using Lambdas::operator()...;
};


constexpr std::string_view kKeyInputs[] = {"keyDown", "keyUp", "char"};

constexpr std::string_view kInputTypes[] = {
    "keyDown",    "keyUp",      "char",        "mouseDown", "mouseUp",
    "mouseMove",  "mouseEnter", "mouseLeave",  "contextMenu",
    "mouseWheel",
};

// sendInputEvent's modifiers, lowercased, as Electron reads them.
constexpr std::string_view kModifiers[] = {
    "shift",          "control",          "ctrl",
    "alt",            "meta",             "command",
    "cmd",            "iskeypad",         "isautorepeat",
    "leftbuttondown", "middlebuttondown", "rightbuttondown",
    "capslock",       "numlock",          "left",
    "right",
};

constexpr std::string_view kButtons[] = {"left", "middle", "right"};

constexpr std::string_view kPageRequests[] = {
    "listen_input",
    "input_answer",
    "send_input_event",
    "set_audio_muted",
    "set_ignore_menu_shortcuts",
    "enable_preferred_size_mode",
    "set_page_user_agent",
};

base::DictValue Event(std::string_view type, int window) {
  base::DictValue event;
  event.Set("type", type);
  event.Set("window", window);
  return event;
}

std::string Line(const base::DictValue& event) {
  std::string line;
  // Strings from UTF-16 and numbers, or a page's JSON: it writes.
  CHECK(base::JSONWriter::Write(event, &line));
  line.push_back('\n');
  return line;
}

base::DictValue Reported(int window, const ElectronPageReport& report) {
  return std::visit(
      Overloaded{
          [&](const ElectronConsoleMessage& message) {
            return Event("console_message", window)
                .Set("level", message.level)
                .Set("message", message.message)
                .Set("line", message.line)
                .Set("source", message.source);
          },
          [&](const ElectronPreloadError& error) {
            return Event("preload_error", window)
                .Set("name", error.name)
                .Set("message", error.message)
                .Set("stack", error.stack);
          },
          [&](const ElectronResponsive& responsive) {
            return Event("responsive", window)
                .Set("responsive", responsive.responsive);
          },
          [&](const ElectronHtmlFullscreen& fullscreen) {
            return Event("html_fullscreen", window)
                .Set("fullscreen", fullscreen.fullscreen);
          },
          [&](const ElectronMediaPlaying& media) {
            return Event("media_playing", window).Set("playing", media.playing);
          },
          [&](const ElectronAudible& audible) {
            return Event("audible", window).Set("audible", audible.audible);
          },
          [&](const ElectronFavicons& favicons) {
            base::ListValue urls;
            for (const std::string& url : favicons.urls) {
              urls.Append(url);
            }
            return Event("favicons", window).Set("urls", std::move(urls));
          },
          [&](const ElectronTargetUrl& target) {
            return Event("target_url", window).Set("url", target.url);
          },
          [&](const ElectronZoomAsked& zoom) {
            return Event("zoom_asked", window).Set("zoom_in", zoom.zoom_in);
          },
          [&](const ElectronThemeColor& theme) {
            base::DictValue event = Event("theme_color", window);
            if (theme.color.has_value()) {
              event.Set("color", *theme.color);
            }
            return event;
          },
          [&](const ElectronCursor& cursor) {
            base::DictValue event =
                Event("cursor_changed", window).Set("cursor", cursor.cursor);
            if (cursor.custom.has_value()) {
              event.Set("image", cursor.custom->image);
              event.Set("scale", cursor.custom->scale);
              event.Set("width", cursor.custom->width);
              event.Set("height", cursor.custom->height);
              event.Set("hotspot_x", cursor.custom->hotspot_x);
              event.Set("hotspot_y", cursor.custom->hotspot_y);
            }
            return event;
          },
          [&](const ElectronPreferredSize& size) {
            return Event("preferred_size", window)
                .Set("width", size.width)
                .Set("height", size.height);
          },
          [&](const ElectronContentBounds& bounds) {
            return Event("content_bounds", window)
                .Set("x", bounds.x)
                .Set("y", bounds.y)
                .Set("width", bounds.width)
                .Set("height", bounds.height);
          },
          [&](const ElectronBeforeInput& input) {
            return Event("before_input", window)
                .Set("ask", input.ask)
                .Set("input", input.input.Clone());
          },
          [&](const ElectronBeforeMouse& mouse) {
            return Event("before_mouse", window)
                .Set("ask", mouse.ask)
                .Set("mouse", mouse.mouse.Clone());
          },
          [&](const ElectronInputEvent& input) {
            return Event("input_event", window)
                .Set("event", input.event.Clone());
          },
      },
      report);
}

base::expected<bool, std::string> BoolIn(const base::DictValue& request,
                                         std::string_view key) {
  const std::optional<bool> value = request.FindBool(key);
  if (!value.has_value()) {
    return base::unexpected(
        base::StrCat({"\"", key, "\" must be true or false"}));
  } else {
    return *value;
  }
}

// `key` of `event`, a number, or `fallback` when it is left out.
base::expected<double, std::string> NumberIn(const base::DictValue& event,
                                             std::string_view key,
                                             double fallback) {
  const base::Value* value = event.Find(key);
  if (value == nullptr) {
    return fallback;
  } else if (!value->is_int() && !value->is_double()) {
    return base::unexpected(
        base::StrCat({"an input event's \"", key, "\" must be a number"}));
  } else {
    return value->GetDouble();
  }
}

base::expected<bool, std::string> FlagIn(const base::DictValue& event,
                                         std::string_view key,
                                         bool fallback) {
  const base::Value* value = event.Find(key);
  if (value == nullptr) {
    return fallback;
  } else if (!value->is_bool()) {
    return base::unexpected(base::StrCat(
        {"an input event's \"", key, "\" must be true or false"}));
  } else {
    return value->GetBool();
  }
}

base::expected<ElectronSyntheticInput, std::string> SyntheticInputIn(
    const base::DictValue* event) {
  if (event == nullptr) {
    return base::unexpected("\"event\" must be an object");
  }
  const std::string* type = event->FindString("type");
  if (type == nullptr || !std::ranges::contains(kInputTypes, *type)) {
    return base::unexpected(
        "an input event's \"type\" must be keyDown, keyUp, char, mouseDown, "
        "mouseUp, mouseMove, mouseEnter, mouseLeave, contextMenu or "
        "mouseWheel");
  }
  ElectronSyntheticInput input{.type = *type};
  if (const base::Value* modifiers = event->Find("modifiers")) {
    if (!modifiers->is_list()) {
      return base::unexpected(
          "an input event's \"modifiers\" must be a list of modifiers");
    }
    for (const base::Value& modifier : modifiers->GetList()) {
      if (!modifier.is_string() ||
          !std::ranges::contains(kModifiers,
                                 base::ToLowerASCII(modifier.GetString()))) {
        return base::unexpected(
            "an input event's \"modifiers\" must each be one of Electron's");
      }
      input.modifiers.push_back(base::ToLowerASCII(modifier.GetString()));
    }
  }
  if (IsElectronKeyInput(input.type)) {
    const std::string* key_code = event->FindString("key_code");
    if (key_code == nullptr || key_code->empty()) {
      return base::unexpected("a key's \"key_code\" must name a key");
    }
    input.key_code = *key_code;
    return input;
  }
  if (const base::Value* button = event->Find("button")) {
    if (!button->is_string() ||
        !std::ranges::contains(kButtons, button->GetString())) {
      return base::unexpected(
          "a mouse event's \"button\" must be left, middle or right");
    }
    input.button = button->GetString();
  }
  if (const base::Value* clicks = event->Find("click_count")) {
    if (!clicks->is_int() || clicks->GetInt() < 0) {
      return base::unexpected(
          "a mouse event's \"click_count\" must be a whole number");
    }
    input.click_count = clicks->GetInt();
  }
  ASSIGN_OR_RETURN(input.x, NumberIn(*event, "x", 0));
  ASSIGN_OR_RETURN(input.y, NumberIn(*event, "y", 0));
  if (event->Find("global_x") != nullptr) {
    ASSIGN_OR_RETURN(input.global_x, NumberIn(*event, "global_x", 0));
  }
  if (event->Find("global_y") != nullptr) {
    ASSIGN_OR_RETURN(input.global_y, NumberIn(*event, "global_y", 0));
  }
  ASSIGN_OR_RETURN(input.movement_x, NumberIn(*event, "movement_x", 0));
  ASSIGN_OR_RETURN(input.movement_y, NumberIn(*event, "movement_y", 0));
  ASSIGN_OR_RETURN(input.delta_x, NumberIn(*event, "delta_x", 0));
  ASSIGN_OR_RETURN(input.delta_y, NumberIn(*event, "delta_y", 0));
  ASSIGN_OR_RETURN(input.wheel_ticks_x, NumberIn(*event, "wheel_ticks_x", 0));
  ASSIGN_OR_RETURN(input.wheel_ticks_y, NumberIn(*event, "wheel_ticks_y", 0));
  ASSIGN_OR_RETURN(input.has_precise_scrolling_deltas,
                   FlagIn(*event, "has_precise_scrolling_deltas", false));
  ASSIGN_OR_RETURN(input.can_scroll, FlagIn(*event, "can_scroll", true));
  return input;
}

}  // namespace

std::string ElectronPageReported(int window, const ElectronPageReport& report) {
  return Line(Reported(window, report));
}

bool IsElectronKeyInput(std::string_view type) {
  return std::ranges::contains(kKeyInputs, type);
}

bool IsElectronPageRequest(std::string_view type) {
  return std::ranges::contains(kPageRequests, type);
}

base::expected<ElectronPageAction, std::string> ParseElectronPageAction(
    std::string_view type,
    const base::DictValue& request) {
  if (type == "listen_input") {
    ASSIGN_OR_RETURN(const bool keys, BoolIn(request, "keys"));
    ASSIGN_OR_RETURN(const bool mouse, BoolIn(request, "mouse"));
    ASSIGN_OR_RETURN(const bool events, BoolIn(request, "events"));
    return ElectronListenInput{.keys = keys, .mouse = mouse, .events = events};
  } else if (type == "input_answer") {
    const std::optional<int> ask = request.FindInt("ask");
    if (!ask.has_value() || *ask < 1) {
      return base::unexpected("\"ask\" must be a whole number from 1");
    }
    ASSIGN_OR_RETURN(const bool prevent, BoolIn(request, "prevent"));
    return ElectronInputAnswer{.ask = *ask, .prevent = prevent};
  } else if (type == "send_input_event") {
    ASSIGN_OR_RETURN(ElectronSyntheticInput event,
                     SyntheticInputIn(request.FindDict("event")));
    return ElectronSendInputEvent{.event = std::move(event)};
  } else if (type == "set_audio_muted") {
    ASSIGN_OR_RETURN(const bool muted, BoolIn(request, "muted"));
    return ElectronSetAudioMuted{.muted = muted};
  } else if (type == "set_ignore_menu_shortcuts") {
    ASSIGN_OR_RETURN(const bool ignore, BoolIn(request, "ignore"));
    return ElectronSetIgnoreMenuShortcuts{.ignore = ignore};
  } else if (type == "enable_preferred_size_mode") {
    return ElectronEnablePreferredSizeMode{};
  } else {
    CHECK_EQ(type, "set_page_user_agent");
    const std::string* user_agent = request.FindString("user_agent");
    if (user_agent == nullptr) {
      return base::unexpected("\"user_agent\" must be a string");
    }
    return ElectronSetPageUserAgent{.user_agent = *user_agent};
  }
}

}  // namespace domicile
